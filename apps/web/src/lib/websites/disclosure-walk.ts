/**
 * Which pages a disclosure walk reads, and in what order. No I/O.
 *
 * The homepage's own legal links come first: sites put the registration
 * number on pages like /terms-of-use or /legal/privacy that no fixed path list
 * guesses.
 */

import { isDiscoveryAggregator } from './crowded-hosts';
import { pageHasCompanyNumber, pageHasPostcode, visibleText } from './extract';
import { DISCLOSURE_PATHS } from './fetch-policy';
import { type StatedOnSite, statedOnPage } from './stated-numbers';

/** Link targets or labels that name a legal page. */
const LEGAL =
  /privacy|terms|legal|cookie|imprint|disclaimer|company[\s_-]*information/i;

/** Homepage legal links walked before the fixed paths. */
export const MAX_LEGAL_LINKS = 6;

/** Bounded label so an unclosed anchor cannot scan the rest of the page. */
const ANCHOR = /<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi;
const HREF = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Host compared www-insensitively, as isSameSite reads a site. */
function siteOf(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** A page as the walk dedupes it: no scheme, `www.` or trailing slash. */
function pageKey(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
}

/** Same-site legal pages a fetched page links to, privacy first, else in page order. */
export function legalLinks(html: string, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const site = siteOf(base.hostname);
  const privacy: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(ANCHOR)) {
    const href = HREF.exec(match[1]);
    const raw = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
    if (!raw || raw.startsWith('#')) continue;
    if (/^(mailto|tel|javascript|data):/i.test(raw)) continue;
    const label = visibleText(match[2]).replace(/\s+/g, ' ').trim();
    if (!LEGAL.test(raw) && !LEGAL.test(label)) continue;
    let url: URL;
    try {
      url = new URL(raw.replace(/&amp;/g, '&'), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || siteOf(url.hostname) !== site) {
      continue;
    }
    url.hash = '';
    const key = url.href.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const isPrivacy = /privacy/i.test(raw) || /privacy/i.test(label);
    (isPrivacy ? privacy : other).push(url.href);
  }
  return [...privacy, ...other];
}

/** The walk's pages in order: homepage legal links not on the fixed list, then the fixed paths. */
export function walkTargets(
  origin: string,
  links: readonly string[],
  maxPaths: number,
): string[] {
  const fixed = new Set(
    DISCLOSURE_PATHS.map((path) => pageKey(`${origin}${path}`)),
  );
  const extra = links
    .filter((link) => !fixed.has(pageKey(link)))
    .slice(0, MAX_LEGAL_LINKS);
  const paths = DISCLOSURE_PATHS.slice(0, maxPaths).map(
    (path) => `${origin}${path}`,
  );
  return [...extra, ...paths];
}

/** What one walked page proves; null when it was served from a directory. */
export function readWalkPage(
  row: { companyNumber: string; postcode: string | null },
  pageUrl: string,
  html: string,
  crowded: ReadonlySet<string>,
): {
  crnFound: boolean;
  postcodeFound: boolean;
  stated: StatedOnSite[];
} | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  // A path that redirects into a register or directory lands on a page about
  // the company, which is not the site naming itself.
  if (isDiscoveryAggregator(host, crowded)) return null;
  return {
    crnFound: pageHasCompanyNumber(html, row.companyNumber),
    postcodeFound: row.postcode ? pageHasPostcode(html, row.postcode) : false,
    stated: statedOnPage(pageUrl, html),
  };
}
