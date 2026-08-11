/**
 * Crawl orchestrator for the company-profiles corpus: one origin in, snapshot
 * rows out. All I/O is injected, mirroring the sweep orchestrators, so the
 * control flow tests without a network.
 *
 * Identity-blind by design — this layer knows nothing about companies or why
 * the origin was chosen. The homepage is fetched with host/scheme variants,
 * the sitemap tier runs under its hard fetch budget, the frontier picks the
 * pages, and each page becomes exactly one snapshot: cleaned text for real
 * content, a status for everything else. Raw HTML never leaves this function.
 */

import { cleanPageText } from './clean';
import {
  chooseChildSitemaps,
  extractLinks,
  MAX_SITEMAP_FETCHES,
  parseSitemapDirectives,
  parseSitemapEntries,
  selectFrontier,
} from './frontier';

/** Snapshot statuses; the plan's taxonomy for company_page_snapshots.status. */
export type SnapshotStatus = 'ok' | 'empty' | 'blocked' | 'error' | 'not_html';

/** Where a frontier path came from, for the eyeball metrics. */
export type PageSource = 'home' | 'link' | 'sitemap' | 'fallback';

export type CrawlPage = {
  /** '' for the root homepage; a path-carrying base keeps its own path. */
  path: string;
  /** Final post-redirect URL actually fetched, or the target we attempted. */
  url: string;
  status: SnapshotStatus;
  /** web-fetch failure taxonomy value when the page was not read. */
  failure: string | null;
  contentText: string | null;
  contentHash: string | null;
  /** Raw fetched HTML size; null when nothing was read. */
  bytes: number | null;
  source: PageSource;
};

export type CrawlResult = {
  /** Canonical origin key for snapshot rows: scheme + host of the base URL. */
  origin: string;
  pages: CrawlPage[];
  /** Sitemap fetches spent, always <= MAX_SITEMAP_FETCHES. */
  sitemapFetches: number;
  sitemapPathsFound: number;
};

export type CrawlFetch =
  | { ok: true; url: string; html: string }
  | { ok: false; reason: string; status?: number };

export type CrawlDeps = {
  /** Fetch a site trying host/scheme variants — the homepage only. */
  fetchSite(url: string): Promise<CrawlFetch>;
  /** Fetch one exact URL — robots, sitemaps, frontier pages. */
  fetchPage(url: string): Promise<CrawlFetch>;
  /** Content hash for stored text (the script injects sha256). */
  hash(text: string): string;
  /** Parked/holding-page classifier over visible text (page-signals). */
  looksParked(text: string): boolean;
  /** WAF/bot-interstitial classifier over visible text (page-signals). */
  looksChallenged(text: string): boolean;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
};

/**
 * Cleaned text shorter than this stores as 'empty'. Deliberately NOT the
 * sweep's pageTooThin (1,500 chars): that bar answers "can absence of an
 * address here be trusted", where a corpus asks "is there any prose worth
 * keeping" — a 778-char dental homepage is real extraction material. Measured
 * on the first 20-origin run, the 1,500 bar discarded genuine identity prose
 * on 21 of 151 pages. Pilot-tunable.
 */
export const MIN_SNAPSHOT_CHARS = 200;

export type CrawlConfig = {
  delayMs: number;
};

/** Canonical snapshot origin key for a stored website URL. The one rule both
 *  the crawler and the selection query share — never re-derive it in SQL. */
export function snapshotOrigin(url: string): string {
  return new URL(url).origin;
}

/** Map a fetch failure onto the snapshot status taxonomy. */
function statusForFailure(reason: string): SnapshotStatus {
  if (reason === 'blocked_by_robots') return 'blocked';
  if (reason === 'not_html') return 'not_html';
  return 'error';
}

/**
 * The stored failure value. HTTP errors carry their status code — 'http_403'
 * and 'http_404' are different diagnoses, and the escalation work-list (which
 * origins deserve a render tier or a manual visit) is built from exactly this
 * distinction. Everything else is the web-fetch taxonomy value as-is.
 */
function failureDetail(reason: string, status?: number): string {
  return reason === 'http_error' && status ? `http_${status}` : reason;
}

/** Build the snapshot for one fetched page body. */
function pageFromHtml(
  deps: CrawlDeps,
  path: string,
  url: string,
  html: string,
  source: PageSource,
): CrawlPage {
  const text = cleanPageText(html);
  // True UTF-8 bytes; String.length would undercount non-ASCII pages.
  const bytes = new TextEncoder().encode(html).length;
  // A 200 that is a bot interstitial is a block wearing a success code. It
  // outranks the thin check so the row carries its real diagnosis — these
  // rows ARE the try-differently-later work-list.
  if (deps.looksChallenged(text)) {
    return {
      path,
      url,
      status: 'blocked',
      failure: 'challenge_page',
      contentText: null,
      contentHash: null,
      bytes,
      source,
    };
  }
  // Junk never enters the corpus: parked and near-empty pages store no text,
  // so extraction cannot ground an answer in a cookie wall or a holding page.
  const junk = text.length < MIN_SNAPSHOT_CHARS || deps.looksParked(text);
  if (junk || !text) {
    return {
      path,
      url,
      status: 'empty',
      failure: null,
      contentText: null,
      contentHash: null,
      bytes,
      source,
    };
  }
  return {
    path,
    url,
    status: 'ok',
    failure: null,
    contentText: text,
    contentHash: deps.hash(text),
    bytes,
    source,
  };
}

/**
 * Crawl one origin: homepage, bounded sitemap probe, frontier pages. Returns
 * every page as a snapshot-shaped row; the caller persists (or prints) them.
 */
export async function crawlOrigin(
  baseUrl: string,
  config: CrawlConfig,
  deps: CrawlDeps,
): Promise<CrawlResult> {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return {
      origin: baseUrl,
      pages: [
        {
          path: '',
          url: baseUrl,
          status: 'error',
          failure: 'unparsable',
          contentText: null,
          contentHash: null,
          bytes: null,
          source: 'home',
        },
      ],
      sitemapFetches: 0,
      sitemapPathsFound: 0,
    };
  }
  const origin = base.origin;
  const basePath = base.pathname.replace(/\/+$/, '');

  const home = await deps.fetchSite(baseUrl);
  if (!home.ok) {
    return {
      origin,
      pages: [
        {
          path: basePath,
          url: baseUrl,
          status: statusForFailure(home.reason),
          failure: failureDetail(home.reason, home.status),
          contentText: null,
          contentHash: null,
          bytes: null,
          source: 'home',
        },
      ],
      sitemapFetches: 0,
      sitemapPathsFound: 0,
    };
  }

  // Frontier paths are fetched where the site actually answers — a stored URL
  // that 301s to a new domain still snapshots under the stored origin key.
  const finalOrigin = new URL(home.url).origin;
  const pages: CrawlPage[] = [
    pageFromHtml(deps, basePath, home.url, home.html, 'home'),
  ];

  // Sitemap tier. robots.txt is a metadata fetch outside the sitemap budget;
  // fetchPage re-reads it beyond web-fetch's internal rules cache, which costs
  // one extra request for the body the rules parser does not expose.
  let sitemapFetches = 0;
  const sitemapPaths: string[] = [];
  await deps.sleep(config.delayMs);
  const robots = await deps.fetchPage(`${finalOrigin}/robots.txt`);
  const directives = robots.ok
    ? parseSitemapDirectives(robots.html, finalOrigin)
    : [];
  const entryCandidates = [
    ...new Set([...directives.slice(0, 1), `${finalOrigin}/sitemap.xml`]),
  ];

  let entry: CrawlFetch | null = null;
  for (const candidate of entryCandidates) {
    if (sitemapFetches >= MAX_SITEMAP_FETCHES) break;
    await deps.sleep(config.delayMs);
    sitemapFetches++;
    const fetched = await deps.fetchPage(candidate);
    if (fetched.ok) {
      entry = fetched;
      break;
    }
  }

  if (entry) {
    const entries = parseSitemapEntries(entry.html, finalOrigin);
    if (entries.kind === 'urlset') {
      sitemapPaths.push(...entries.paths);
    } else {
      for (const child of chooseChildSitemaps(entries.children)) {
        if (sitemapFetches >= MAX_SITEMAP_FETCHES) break;
        await deps.sleep(config.delayMs);
        sitemapFetches++;
        const fetched = await deps.fetchPage(child);
        if (!fetched.ok) continue;
        const childEntries = parseSitemapEntries(fetched.html, finalOrigin);
        if (childEntries.kind === 'urlset') {
          sitemapPaths.push(...childEntries.paths);
        }
      }
    }
  }

  // Provenance per chosen path, for the eyeball metrics: a path that was a
  // real anchor counts as a link even if the sitemap also listed it, matching
  // tier precedence.
  const links = extractLinks(home.html, home.url);
  const chosen = selectFrontier(links, sitemapPaths);
  const fromLinks = new Set(links.map((link) => link.path.toLowerCase()));
  const fromSitemap = new Set(sitemapPaths.map((path) => path.toLowerCase()));
  const sourceOf = (path: string): PageSource => {
    const key = path.toLowerCase();
    if (fromLinks.has(key)) return 'link';
    if (fromSitemap.has(key)) return 'sitemap';
    return 'fallback';
  };

  for (const path of chosen) {
    await deps.sleep(config.delayMs);
    const target = `${finalOrigin}${path}`;
    const fetched = await deps.fetchPage(target);
    if (!fetched.ok) {
      pages.push({
        path,
        url: target,
        status: statusForFailure(fetched.reason),
        failure: failureDetail(fetched.reason, fetched.status),
        contentText: null,
        contentHash: null,
        bytes: null,
        source: sourceOf(path),
      });
      continue;
    }
    pages.push(
      pageFromHtml(deps, path, fetched.url, fetched.html, sourceOf(path)),
    );
  }

  return {
    origin,
    pages,
    sitemapFetches,
    sitemapPathsFound: sitemapPaths.length,
  };
}
