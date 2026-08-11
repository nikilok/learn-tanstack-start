import { describe, expect, test } from 'bun:test';

import type { CrawlDeps, CrawlFetch } from './crawl';
import { crawlOrigin, snapshotOrigin } from './crawl';
import { MAX_SITEMAP_FETCHES } from './frontier';

type Route =
  | string
  | { html: string; finalUrl: string }
  | { fail: string; status?: number };

/** Fake I/O: a url→route map plus call recorders. */
function fakeCrawl(routes: Record<string, Route>) {
  const pageCalls: string[] = [];
  const siteCalls: string[] = [];
  const resolve = (url: string): CrawlFetch => {
    const route = routes[url];
    if (route === undefined) {
      return { ok: false, reason: 'http_error', status: 404 };
    }
    if (typeof route === 'string') return { ok: true, url, html: route };
    if ('fail' in route) {
      return { ok: false, reason: route.fail, status: route.status };
    }
    return { ok: true, url: route.finalUrl, html: route.html };
  };
  const deps: CrawlDeps = {
    fetchSite: async (url) => {
      siteCalls.push(url);
      return resolve(url);
    },
    fetchPage: async (url) => {
      pageCalls.push(url);
      return resolve(url);
    },
    hash: (text) => `hash-${text.length}`,
    looksParked: (text) => text.includes('domain for sale'),
    looksChallenged: (text) => text.includes('Just a moment'),
    sleep: async () => {},
    log: () => {},
  };
  return { deps, pageCalls, siteCalls };
}

const CONFIG = { delayMs: 0 };
const B = 'https://example.co.uk';
const PROSE = `<main><p>${'A family-run care provider established in Brighton in 1999, offering residential, respite and dementia care with an emphasis on dignity. '.repeat(2)}</p></main>`;

describe('crawlOrigin', () => {
  test('happy path: links, sitemap and fallbacks become snapshot rows', async () => {
    const home = `<nav><a href="/about-us">About us</a><a href="/care-services">Services</a></nav>
      <main><p>${'Acme provides domiciliary care across Sussex and beyond, with trained carers supporting independence at home for older people and their families. '.repeat(2)}</p></main>`;
    const { deps, pageCalls } = fakeCrawl({
      [B]: home,
      [`${B}/robots.txt`]: 'Sitemap: https://example.co.uk/sitemap.xml',
      [`${B}/sitemap.xml`]: `<urlset>
        <url><loc>https://example.co.uk/what-we-do</loc></url>
        <url><loc>https://example.co.uk/company/acme-1</loc></url>
      </urlset>`,
      [`${B}/about-us`]: PROSE,
      [`${B}/care-services`]: PROSE,
      [`${B}/what-we-do`]: PROSE,
    });
    const result = await crawlOrigin(B, CONFIG, deps);

    expect(result.origin).toBe(B);
    expect(result.sitemapFetches).toBe(1);
    expect(result.sitemapPathsFound).toBe(1);
    expect(result.pages).toHaveLength(8);

    const homePage = result.pages[0];
    expect(homePage.path).toBe('');
    expect(homePage.source).toBe('home');
    expect(homePage.status).toBe('ok');
    expect(homePage.contentText).toContain('domiciliary care');
    // The nav is chrome; it must not enter the corpus.
    expect(homePage.contentText).not.toContain('About us');
    expect(homePage.bytes).toBe(home.length);
    expect(homePage.contentHash).toBeTruthy();

    const byPath = new Map(result.pages.map((page) => [page.path, page]));
    expect(byPath.get('/about-us')?.source).toBe('link');
    expect(byPath.get('/about-us')?.status).toBe('ok');
    expect(byPath.get('/what-we-do')?.source).toBe('sitemap');
    expect(byPath.get('/about')?.source).toBe('fallback');
    expect(byPath.get('/about')?.status).toBe('error');
    expect(byPath.get('/about')?.failure).toBe('http_404');

    // Catalog rows never rode the 'company' keyword in.
    expect(byPath.has('/company/acme-1')).toBe(false);
    expect(pageCalls.filter((url) => url.endsWith('robots.txt'))).toHaveLength(
      1,
    );
  });

  test('an index spends the whole budget on chosen children only', async () => {
    const { deps, pageCalls } = fakeCrawl({
      [B]: PROSE,
      [`${B}/robots.txt`]: 'Sitemap: https://example.co.uk/sitemap_index.xml',
      [`${B}/sitemap_index.xml`]: `<sitemapindex>
        <sitemap><loc>https://example.co.uk/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.co.uk/page-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.co.uk/sitemap-a.xml</loc></sitemap>
        <sitemap><loc>https://example.co.uk/sitemap-b.xml</loc></sitemap>
      </sitemapindex>`,
      [`${B}/page-sitemap.xml`]: `<urlset><url><loc>https://example.co.uk/about-us</loc></url></urlset>`,
      [`${B}/sitemap-a.xml`]: `<urlset><url><loc>https://example.co.uk/our-services</loc></url></urlset>`,
    });
    const result = await crawlOrigin(B, CONFIG, deps);

    expect(result.sitemapFetches).toBe(MAX_SITEMAP_FETCHES);
    expect(result.sitemapPathsFound).toBe(2);
    expect(pageCalls).toContain(`${B}/page-sitemap.xml`);
    expect(pageCalls).toContain(`${B}/sitemap-a.xml`);
    expect(pageCalls).not.toContain(`${B}/sitemap-b.xml`);
    expect(pageCalls).not.toContain(`${B}/post-sitemap.xml`);
  });

  test('a dead directive entry falls back to conventional /sitemap.xml', async () => {
    const { deps } = fakeCrawl({
      [B]: PROSE,
      [`${B}/robots.txt`]: 'Sitemap: https://example.co.uk/broken.xml',
      [`${B}/broken.xml`]: { fail: 'http_error', status: 404 },
      [`${B}/sitemap.xml`]: `<urlset><url><loc>https://example.co.uk/about-us</loc></url></urlset>`,
      [`${B}/about-us`]: PROSE,
    });
    const result = await crawlOrigin(B, CONFIG, deps);

    expect(result.sitemapFetches).toBe(2);
    const about = result.pages.find((page) => page.path === '/about-us');
    expect(about?.source).toBe('sitemap');
    expect(about?.status).toBe('ok');
  });

  test('a homepage failure records one row and fetches nothing else', async () => {
    const { deps, pageCalls } = fakeCrawl({
      [B]: { fail: 'dns_or_refused' },
    });
    const result = await crawlOrigin(B, CONFIG, deps);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].status).toBe('error');
    expect(result.pages[0].failure).toBe('dns_or_refused');
    expect(pageCalls).toHaveLength(0);
  });

  test('a JS-shell homepage runs on the sitemap tier and stores no text', async () => {
    const { deps } = fakeCrawl({
      [B]: '<div id="root"></div>',
      [`${B}/robots.txt`]: 'Sitemap: https://example.co.uk/sitemap.xml',
      [`${B}/sitemap.xml`]: `<urlset><url><loc>https://example.co.uk/about-us</loc></url></urlset>`,
      [`${B}/about-us`]: PROSE,
    });
    const result = await crawlOrigin(B, CONFIG, deps);

    const home = result.pages[0];
    expect(home.status).toBe('empty');
    expect(home.contentText).toBeNull();
    expect(home.bytes).toBeGreaterThan(0);
    const about = result.pages.find((page) => page.path === '/about-us');
    expect(about?.source).toBe('sitemap');
    expect(about?.status).toBe('ok');
  });

  test('failure taxonomy maps onto snapshot statuses; parked pages store no text', async () => {
    const { deps } = fakeCrawl({
      [B]: PROSE,
      [`${B}/about`]: { fail: 'blocked_by_robots' },
      [`${B}/services`]: { fail: 'not_html' },
      // Long enough to clear MIN_SNAPSHOT_CHARS, so the parked verdict comes
      // from looksParked itself and not the thin-text gate before it.
      [`${B}/products`]: `<p>this domain for sale by owner, enquire within today. ${'The owner has priced this premium domain to sell quickly and invites serious offers from interested parties. '.repeat(3)}</p>`,
    });
    const result = await crawlOrigin(B, CONFIG, deps);
    const byPath = new Map(result.pages.map((page) => [page.path, page]));

    expect(byPath.get('/about')?.status).toBe('blocked');
    expect(byPath.get('/services')?.status).toBe('not_html');
    const parked = byPath.get('/products');
    expect(parked?.status).toBe('empty');
    expect(parked?.contentText).toBeNull();
    expect(parked?.bytes).toBeGreaterThan(0);
  });

  test('http failures carry their status code for the escalation work-list', async () => {
    const { deps } = fakeCrawl({
      [B]: PROSE,
      [`${B}/about`]: { fail: 'http_error', status: 403 },
      [`${B}/services`]: { fail: 'http_error' },
    });
    const result = await crawlOrigin(B, CONFIG, deps);
    const byPath = new Map(result.pages.map((page) => [page.path, page]));

    // A 403 (challenged/denied) and a 404 (page missing) are different
    // diagnoses; both must survive into the stored row.
    expect(byPath.get('/about')?.failure).toBe('http_403');
    expect(byPath.get('/about-us')?.failure).toBe('http_404');
    expect(byPath.get('/services')?.failure).toBe('http_error');
  });

  test('a challenge interstitial behind a 200 is blocked, not ok or empty', async () => {
    const challenge =
      '<p>Just a moment while we verify your connection is secure before you continue to the site you requested today.</p>';
    const { deps } = fakeCrawl({
      [B]: challenge,
      [`${B}/about`]: challenge,
    });
    const result = await crawlOrigin(B, CONFIG, deps);

    const home = result.pages[0];
    expect(home.status).toBe('blocked');
    expect(home.failure).toBe('challenge_page');
    expect(home.contentText).toBeNull();
    expect(home.bytes).toBe(challenge.length);
    const about = result.pages.find((page) => page.path === '/about');
    expect(about?.failure).toBe('challenge_page');
  });

  test('a stored URL that redirects crawls the answering origin, keyed to the stored one', async () => {
    const { deps, pageCalls } = fakeCrawl({
      [B]: {
        html: '<a href="/about-us">About</a>',
        finalUrl: 'https://new.example.org/',
      },
      ['https://new.example.org/about-us']: PROSE,
    });
    const result = await crawlOrigin(B, CONFIG, deps);

    expect(result.origin).toBe(B);
    expect(pageCalls[0]).toBe('https://new.example.org/robots.txt');
    const about = result.pages.find((page) => page.path === '/about-us');
    expect(about?.url).toBe('https://new.example.org/about-us');
  });

  test('bytes count UTF-8, not string units', async () => {
    const html = `<main><p>${'Für die Familie — häusliche Pflege im Süden, größte Sorgfalt. '.repeat(6)}</p></main>`;
    const { deps } = fakeCrawl({ [B]: html });
    const result = await crawlOrigin(B, CONFIG, deps);
    expect(result.pages[0].bytes).toBeGreaterThan(html.length);
  });

  test('an unparsable base is one error row', async () => {
    const { deps, pageCalls } = fakeCrawl({});
    const result = await crawlOrigin('not a url', CONFIG, deps);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].failure).toBe('unparsable');
    expect(pageCalls).toHaveLength(0);
  });

  test('a path-carrying base never duplicates its own path in the frontier', async () => {
    // /about-us sits in the fallback tier, so without the basePath filter the
    // home row and a frontier fetch would collide on one (origin, path).
    const base = 'https://example.co.uk/about-us';
    const { deps } = fakeCrawl({ [base]: PROSE });
    const result = await crawlOrigin(base, CONFIG, deps);
    const paths = result.pages.map((page) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((path) => path === '/about-us')).toHaveLength(1);
  });
});

describe('snapshotOrigin', () => {
  test('strips a load-bearing path down to the origin key', () => {
    expect(snapshotOrigin('https://caremark.co.uk/arun')).toBe(
      'https://caremark.co.uk',
    );
  });
});
