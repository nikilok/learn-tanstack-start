/**
 * Which pages of a company site the profiles crawler fetches after the
 * homepage. Pure: links in, ordered fetch list out — the caller owns all I/O.
 *
 * A bounded deterministic frontier, not an agentic crawler, choosing from
 * three sources in strict evidence order: homepage anchors (curated nav),
 * sitemap-declared paths (the site's own page inventory, from robots.txt
 * `Sitemap:` directives or /sitemap.xml), and ranked fallback paths only into
 * slots the first two leave empty (the measured basis for ranked-path walking
 * is docs/website-discovery-adjudication.md). Sitemap traversal is hard
 * bounded — see MAX_SITEMAP_FETCHES — because the protocol's legal worst case
 * is 50k child sitemaps of 50k URLs each and we only ever want a handful of
 * keyword-matching paths.
 */

import { visibleText } from '../websites/extract';

/** One anchor lifted from a fetched page: site-local path plus visible label. */
export type PageLink = { path: string; text: string };

/** Total fetches one site may cost: the homepage plus everything chosen here. */
export const MAX_PAGES_PER_SITE = 8;

/** Scored homepage links taken before fallbacks fill the remainder. */
export const MAX_SCORED_LINKS = 5;

/**
 * Ranked paths tried even when no homepage link scores — where identity prose
 * lives when a site's nav is JS-rendered or image-based. Root-absolute: a
 * path-carrying base (franchise subtrees) still reaches its own pages through
 * scored links, which resolve against the base.
 */
export const FALLBACK_PATHS = [
  '/about',
  '/about-us',
  '/services',
  '/products',
  '/what-we-do',
  '/solutions',
];

/** Priority order for lexical scoring; an earlier keyword outranks a later. */
const KEYWORDS = [
  'about',
  'services',
  'products',
  'what-we-do',
  'solutions',
  'company',
];

/** Link targets that cannot carry readable identity prose. */
const SKIPPED_EXTENSIONS =
  /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|zip|gz|mp[34]|webm|ics)$/i;

/** Bounds the work a pathological page full of anchors can cost. */
const MAX_EXTRACTED_LINKS = 500;

const ANCHOR =
  /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

/** Hosts compare www-insensitively, matching isSameSite's reading of a site. */
function siteHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Lift same-site anchors out of a fetched page, resolved against the URL the
 * page was fetched from. Document order; dedupe belongs to selection.
 */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const host = siteHost(base.hostname);
  const basePath = base.pathname.replace(/\/+$/, '');
  const links: PageLink[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    if (links.length >= MAX_EXTRACTED_LINKS) break;
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      continue;
    }
    if (siteHost(resolved.hostname) !== host) continue;
    const path = resolved.pathname.replace(/\/+$/, '');
    // '' is the homepage; basePath is the page we are already reading.
    if (!path || path === basePath) continue;
    if (SKIPPED_EXTENSIONS.test(path)) continue;
    const text = visibleText(match[4] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    links.push({ path, text });
  }
  return links;
}

/** Normalised form both paths and labels are scored on. */
function scoreKey(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, '-');
}

/** Rank of the best keyword a link carries, or Infinity when none. */
function keywordRank(link: PageLink): number {
  const haystack = `${scoreKey(link.path)} ${scoreKey(link.text)}`;
  const rank = KEYWORDS.findIndex((keyword) => haystack.includes(keyword));
  return rank === -1 ? Infinity : rank;
}

/**
 * Sitemap fetches one origin may ever cost: the entry plus its chosen
 * children. The budget the crawl assembly must enforce; nothing here fetches.
 */
export const MAX_SITEMAP_FETCHES = 3;

/** Child sitemaps fetched from an index; the tree is never walked. */
export const MAX_CHILD_SITEMAPS = 2;

/** Locs scanned per sitemap file before giving up early. */
export const MAX_SITEMAP_LOCS_SCANNED = 2000;

/** Keyword-matching paths collected per urlset before stopping early. */
export const MAX_SITEMAP_CANDIDATES = 20;

export type SitemapEntries =
  | { kind: 'index'; children: string[] }
  | { kind: 'urlset'; paths: string[] };

const LOC =
  /<loc\b[^>]*>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;

/** Child sitemaps whose names promise catalog rows, not identity pages. */
const CHILD_DEPRIORITIZED =
  /post|blog|product|category|tag|author|news|image|video/i;

/** Preference order among sitemap files: pages first, catalogs last. */
function childSitemapRank(url: string): number {
  if (/page/i.test(url)) return 0;
  if (CHILD_DEPRIORITIZED.test(url)) return 2;
  return 1;
}

/** Resolve a sitemap URL we can actually fetch: same site, http(s), not .gz. */
function fetchableSitemapUrl(
  raw: string,
  host: string,
  base: URL,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (siteHost(parsed.hostname) !== host) return null;
  // Gunzip is unsupported in v1; the small-business platforms this population
  // lives on serve plain XML.
  if (/\.gz$/i.test(parsed.pathname)) return null;
  return parsed.toString();
}

/**
 * Sitemap URLs a robots.txt declares, same-site only, page-flavoured first.
 * The caller tries the first and may fall back to conventional /sitemap.xml.
 */
export function parseSitemapDirectives(
  robotsBody: string,
  baseUrl: string,
): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const host = siteHost(base.hostname);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of robotsBody.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^sitemap\s*:\s*(\S+)/i.exec(line);
    if (!match) continue;
    const url = fetchableSitemapUrl(match[1], host, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found.sort((a, b) => childSitemapRank(a) - childSitemapRank(b));
}

/**
 * Uncurated inventory scores on the page's own slug, so a '/company/acme-ltd'
 * catalog row cannot ride the 'company' keyword into the frontier.
 */
function sitemapPathRank(path: string): number {
  return keywordRank({ path: path.slice(path.lastIndexOf('/') + 1), text: '' });
}

/**
 * One capped scan of one sitemap file: an index yields fetchable child URLs,
 * a urlset yields keyword-matching same-site paths. Regex-scanned, so real
 * sitemaps that fail XML well-formedness still parse; early exit on both caps
 * means a 126k-URL catalog file is never materialized.
 */
export function parseSitemapEntries(
  xml: string,
  baseUrl: string,
): SitemapEntries {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { kind: 'urlset', paths: [] };
  }
  const host = siteHost(base.hostname);
  const isIndex = /<sitemapindex\b/i.test(xml);
  const children: string[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const match of xml.matchAll(LOC)) {
    if (++scanned > MAX_SITEMAP_LOCS_SCANNED) break;
    const loc = match[1].trim();
    if (isIndex) {
      const url = fetchableSitemapUrl(loc, host, base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      children.push(url);
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(loc, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      continue;
    }
    if (siteHost(resolved.hostname) !== host) continue;
    const path = resolved.pathname.replace(/\/+$/, '');
    if (!path || SKIPPED_EXTENSIONS.test(path)) continue;
    if (sitemapPathRank(path) === Infinity) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
    if (paths.length >= MAX_SITEMAP_CANDIDATES) break;
  }
  return isIndex ? { kind: 'index', children } : { kind: 'urlset', paths };
}

/** Which children of an index are worth the fetch budget: pages-flavoured
 *  first, catalogs last, document order between equals, capped. */
export function chooseChildSitemaps(children: string[]): string[] {
  return children
    .map((url, order) => ({ url, order, rank: childSitemapRank(url) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_CHILD_SITEMAPS)
    .map((entry) => entry.url);
}

/**
 * Order the paths worth fetching after the homepage: scored links, then
 * sitemap-declared paths, then ranked fallbacks — deduped across tiers,
 * capped at MAX_PAGES_PER_SITE - 1.
 */
export function selectFrontier(
  links: PageLink[],
  sitemapPaths: string[] = [],
): string[] {
  const chosen: string[] = [];
  const seen = new Set<string>();
  const take = (path: string) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    chosen.push(path);
  };

  const scored = links
    .map((link, order) => ({ link, rank: keywordRank(link), order }))
    .filter((entry) => entry.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  for (const entry of scored) {
    if (chosen.length >= MAX_SCORED_LINKS) break;
    take(entry.link.path);
  }

  const declared = sitemapPaths
    .map((path, order) => ({ path, rank: sitemapPathRank(path), order }))
    .filter((entry) => entry.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  for (const entry of declared) {
    if (chosen.length >= MAX_PAGES_PER_SITE - 1) break;
    take(entry.path);
  }

  for (const path of FALLBACK_PATHS) {
    if (chosen.length >= MAX_PAGES_PER_SITE - 1) break;
    take(path);
  }
  return chosen;
}

/** The full frontier decision for one fetched homepage. */
export function frontierPaths(
  html: string,
  baseUrl: string,
  sitemapPaths: string[] = [],
): string[] {
  return selectFrontier(extractLinks(html, baseUrl), sitemapPaths);
}
