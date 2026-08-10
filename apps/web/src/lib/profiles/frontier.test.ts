import { describe, expect, test } from 'bun:test';

import {
  chooseChildSitemaps,
  extractLinks,
  FALLBACK_PATHS,
  frontierPaths,
  MAX_CHILD_SITEMAPS,
  MAX_PAGES_PER_SITE,
  MAX_SCORED_LINKS,
  MAX_SITEMAP_CANDIDATES,
  parseSitemapDirectives,
  parseSitemapEntries,
  selectFrontier,
} from './frontier';

const BASE = 'https://example.co.uk';

describe('extractLinks', () => {
  test('resolves relative and absolute same-site links in document order', () => {
    const html = `
      <a href="/about">About</a>
      <a href="services/">Our Services</a>
      <a href="https://www.example.co.uk/products">Products</a>`;
    expect(extractLinks(html, `${BASE}/`)).toEqual([
      { path: '/about', text: 'About' },
      { path: '/services', text: 'Our Services' },
      { path: '/products', text: 'Products' },
    ]);
  });

  test('www and apex are one site; other hosts and schemes are not', () => {
    const html = `
      <a href="https://example.co.uk/team">Team</a>
      <a href="https://shop.example.co.uk/x">Shop</a>
      <a href="https://other.co.uk/about">Elsewhere</a>
      <a href="mailto:care@example.co.uk">Email</a>
      <a href="tel:01234567890">Call</a>
      <a href="javascript:void(0)">Menu</a>`;
    expect(extractLinks(html, `https://www.example.co.uk`)).toEqual([
      { path: '/team', text: 'Team' },
    ]);
  });

  test('skips the homepage, the page itself, and asset targets', () => {
    const html = `
      <a href="/">Home</a>
      <a href="#top">Top</a>
      <a href="/arun">This page</a>
      <a href="/brochure.pdf">Brochure</a>
      <a href="/about#team">About</a>`;
    // A path-carrying base is one franchise's subtree (the caremark.co.uk/arun
    // shape) — its own path must not be re-fetched as a frontier page.
    expect(extractLinks(html, `${BASE}/arun`)).toEqual([
      { path: '/about', text: 'About' },
    ]);
  });

  test('reads the label through nested markup and entities', () => {
    const html = '<a href="/about"><span>About</span> &amp; <b>Contact</b></a>';
    expect(extractLinks(html, BASE)).toEqual([
      { path: '/about', text: 'About & Contact' },
    ]);
  });

  test('returns nothing for an unparsable base', () => {
    expect(extractLinks('<a href="/about">About</a>', 'not a url')).toEqual([]);
  });
});

describe('selectFrontier', () => {
  test('scores by keyword priority, tie-broken by document order', () => {
    const paths = selectFrontier([
      { path: '/news', text: 'News' },
      { path: '/products', text: 'Products' },
      { path: '/first-services', text: 'Care' },
      { path: '/what-we-do', text: '' },
      { path: '/second-services', text: 'More care' },
      { path: '/about-us', text: '' },
    ]);
    // about > services > products > what-we-do; the two services keep order.
    expect(paths.slice(0, 5)).toEqual([
      '/about-us',
      '/first-services',
      '/second-services',
      '/products',
      '/what-we-do',
    ]);
  });

  test('matches keywords in the label as well as the path', () => {
    const paths = selectFrontier([
      { path: '/who-we-are', text: 'About our company' },
      { path: '/x1', text: 'What we do' },
    ]);
    expect(paths[0]).toBe('/who-we-are');
    expect(paths[1]).toBe('/x1');
  });

  test('caps at MAX_PAGES_PER_SITE - 1 with scored links before fallbacks', () => {
    const links = Array.from({ length: 12 }, (_, i) => ({
      path: `/services-${i}`,
      text: '',
    }));
    const paths = selectFrontier(links);
    expect(paths).toHaveLength(MAX_PAGES_PER_SITE - 1);
    expect(paths.slice(0, MAX_SCORED_LINKS)).toEqual([
      '/services-0',
      '/services-1',
      '/services-2',
      '/services-3',
      '/services-4',
    ]);
    // The remainder comes from the fallback ranking.
    expect(paths.slice(MAX_SCORED_LINKS)).toEqual(FALLBACK_PATHS.slice(0, 2));
  });

  test('dedupes case and fallback overlap', () => {
    const paths = selectFrontier([
      { path: '/About', text: '' },
      { path: '/about', text: '' },
    ]);
    // The scored '/About' claims the slot; the '/about' fallback must not
    // fetch the same page twice.
    expect(paths.filter((p) => p.toLowerCase() === '/about')).toHaveLength(1);
    expect(paths[0]).toBe('/About');
  });

  test('no scored links means the ranked fallbacks, in order', () => {
    expect(selectFrontier([])).toEqual(
      FALLBACK_PATHS.slice(0, MAX_PAGES_PER_SITE - 1),
    );
  });
});

describe('parseSitemapDirectives', () => {
  test('extracts same-site directives, page-flavoured first', () => {
    const robots = `# robots
User-agent: *
Disallow: /admin
Sitemap: https://example.co.uk/sitemap.xml
sitemap: https://www.example.co.uk/page-sitemap.xml
Sitemap: https://cdn.example-static.com/sitemap.xml
Sitemap: https://example.co.uk/sitemap.xml.gz`;
    expect(parseSitemapDirectives(robots, BASE)).toEqual([
      'https://www.example.co.uk/page-sitemap.xml',
      'https://example.co.uk/sitemap.xml',
    ]);
  });

  test('no directives means no entries', () => {
    expect(parseSitemapDirectives('User-agent: *\nDisallow:', BASE)).toEqual(
      [],
    );
  });
});

describe('parseSitemapEntries', () => {
  test('a urlset yields keyword-matching same-site paths only', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.co.uk/</loc></url>
      <url><loc>https://www.example.co.uk/about-us/</loc></url>
      <url><loc><![CDATA[https://example.co.uk/our-services]]></loc></url>
      <url><loc>https://example.co.uk/logo.svg</loc></url>
      <url><loc>https://other.co.uk/about</loc></url>
      <url><loc>https://example.co.uk/news</loc></url>
    </urlset>`;
    expect(parseSitemapEntries(xml, BASE)).toEqual({
      kind: 'urlset',
      paths: ['/about-us', '/our-services'],
    });
  });

  test('inventory scores on the slug, not the whole path', () => {
    // A catalog row like ours must not ride the 'company' keyword in.
    const xml = `<urlset>
      <url><loc>https://example.co.uk/company/acme-ltd</loc></url>
      <url><loc>https://example.co.uk/company</loc></url>
    </urlset>`;
    expect(parseSitemapEntries(xml, BASE)).toEqual({
      kind: 'urlset',
      paths: ['/company'],
    });
  });

  test('stops at the candidate cap', () => {
    const xml = `<urlset>${Array.from(
      { length: 60 },
      (_, i) => `<url><loc>https://example.co.uk/about-team-${i}</loc></url>`,
    ).join('')}</urlset>`;
    const entries = parseSitemapEntries(xml, BASE);
    expect(entries.kind).toBe('urlset');
    if (entries.kind === 'urlset') {
      expect(entries.paths).toHaveLength(MAX_SITEMAP_CANDIDATES);
    }
  });

  test('stops at the scan cap before a late match', () => {
    const noise = Array.from(
      { length: 2500 },
      (_, i) => `<url><loc>https://example.co.uk/item-${i}</loc></url>`,
    ).join('');
    const xml = `<urlset>${noise}<url><loc>https://example.co.uk/about</loc></url></urlset>`;
    expect(parseSitemapEntries(xml, BASE)).toEqual({
      kind: 'urlset',
      paths: [],
    });
  });

  test('an index yields fetchable children, never paths', () => {
    const xml = `<sitemapindex>
      <sitemap><loc>https://example.co.uk/sitemap-0.xml</loc></sitemap>
      <sitemap><loc>https://example.co.uk/sitemap-1.xml.gz</loc></sitemap>
      <sitemap><loc>https://cdn.example-static.com/sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.co.uk/sitemap-2.xml</loc></sitemap>
    </sitemapindex>`;
    expect(parseSitemapEntries(xml, BASE)).toEqual({
      kind: 'index',
      children: [
        'https://example.co.uk/sitemap-0.xml',
        'https://example.co.uk/sitemap-2.xml',
      ],
    });
  });

  test('tolerates malformed XML around the locs', () => {
    const xml = 'not xml at all <loc>https://example.co.uk/about</loc> tail';
    expect(parseSitemapEntries(xml, BASE)).toEqual({
      kind: 'urlset',
      paths: ['/about'],
    });
  });
});

describe('chooseChildSitemaps', () => {
  test('pages beat catalogs regardless of order, capped', () => {
    const chosen = chooseChildSitemaps([
      'https://example.co.uk/post-sitemap.xml',
      'https://example.co.uk/product-sitemap.xml',
      'https://example.co.uk/page-sitemap.xml',
    ]);
    expect(chosen).toEqual([
      'https://example.co.uk/page-sitemap.xml',
      'https://example.co.uk/post-sitemap.xml',
    ]);
    expect(chosen).toHaveLength(MAX_CHILD_SITEMAPS);
  });

  test('the sponsorsearch shape: sequential chunks, first two, no yield', () => {
    // Our own site is 126k URLs across 4 chunk files behind an index. Against
    // a target shaped like that, the tier must cost two chosen children and
    // contribute nothing.
    const index = `<sitemapindex>${[0, 1, 2, 3]
      .map(
        (i) =>
          `<sitemap><loc>https://example.co.uk/sitemap-${i}.xml</loc></sitemap>`,
      )
      .join('')}</sitemapindex>`;
    const entries = parseSitemapEntries(index, BASE);
    expect(entries.kind).toBe('index');
    const children = entries.kind === 'index' ? entries.children : [];
    expect(chooseChildSitemaps(children)).toEqual([
      'https://example.co.uk/sitemap-0.xml',
      'https://example.co.uk/sitemap-1.xml',
    ]);
    const chunk = `<urlset>${Array.from(
      { length: 500 },
      (_, i) => `<url><loc>https://example.co.uk/company/acme-${i}</loc></url>`,
    ).join('')}</urlset>`;
    expect(parseSitemapEntries(chunk, BASE)).toEqual({
      kind: 'urlset',
      paths: [],
    });
  });
});

describe('selectFrontier with sitemap paths', () => {
  test('sitemap paths fill after links, before fallbacks, deduped', () => {
    const paths = selectFrontier(
      [{ path: '/about-us', text: '' }],
      ['/About-Us', '/our-services', '/products-range'],
    );
    expect(paths.slice(0, 3)).toEqual([
      '/about-us',
      '/our-services',
      '/products-range',
    ]);
    expect(paths).toHaveLength(MAX_PAGES_PER_SITE - 1);
    expect(paths.slice(3)).toEqual([
      '/about',
      '/services',
      '/products',
      '/what-we-do',
    ]);
  });

  test('a JS-shell homepage runs entirely on the sitemap tier', () => {
    const declared = [
      '/about-the-team',
      '/our-services',
      '/care-services',
      '/products-list',
      '/what-we-do',
      '/solutions-hub',
      '/company',
      '/about-us',
    ];
    const paths = selectFrontier([], declared);
    expect(paths).toHaveLength(MAX_PAGES_PER_SITE - 1);
    for (const path of paths) {
      expect(declared).toContain(path);
    }
  });
});

describe('frontierPaths', () => {
  test('end to end: nav links win, fallbacks fill, cross-site noise drops', () => {
    const html = `
      <nav>
        <a href="/about-us">About us</a>
        <a href="/care-services">Services</a>
        <a href="https://facebook.com/example">Facebook</a>
      </nav>
      <a href="/contact">Contact</a>`;
    const paths = frontierPaths(html, BASE);
    expect(paths[0]).toBe('/about-us');
    expect(paths[1]).toBe('/care-services');
    expect(paths).not.toContain('/contact');
    expect(paths).toHaveLength(MAX_PAGES_PER_SITE - 1);
    expect(paths).toContain('/products');
  });
});
