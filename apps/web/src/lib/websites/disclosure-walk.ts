/**
 * What a candidate's fetched pages prove, and which pages a disclosure walk
 * reads, in what order. No I/O.
 *
 * The homepage's own legal links come first: sites put the registration
 * number on pages like /terms-of-use or /legal/privacy that no fixed path list
 * guesses.
 */

import { type CompanyNames, namesCompany } from './company-naming';
import { isDiscoveryAggregator } from './crowded-hosts';
import type { CandidateProbe } from './discover';
import { pageHasPostcode, visibleText } from './extract';
import { DISCLOSURE_PATHS } from './fetch-policy';
import { isListingEntry } from './listing-entry';
import { type PageRead, readPage } from './name-and-place';
import { looksChallenged, looksParked, pageTooThin } from './page-signals';
import {
  pageShowsCompanyNumber,
  type StatedOnSite,
  statedOnPage,
} from './stated-numbers';

/** Link targets or labels that name a legal page. */
const LEGAL =
  /privacy|terms|legal|cookie|imprint|disclaimer|company[\s_-]*information/i;

/** Link targets or labels that name a page about the company or its people. */
const ABOUT =
  /about|team|people|who-?we-?are|our-?story|leadership|management|directors?|meet-?the|founders?|staff/i;

/** Homepage legal links walked before the fixed paths. */
export const MAX_LEGAL_LINKS = 6;

/** Homepage about and team links walked after the fixed paths. */
export const MAX_ABOUT_LINKS = 3;

/** Same-site links of a page read for about links, in page order. */
const MAX_SITE_LINKS = 250;

/** Files and assets a link may point at, which are not pages. */
const NOT_HTML =
  /\.(pdf|jpe?g|png|gif|svg|webp|ico|css|js|json|xml|zip|docx?|xlsx?|pptx?|mp[34]|mov|avi|woff2?|ttf)(?:$|\?)/i;

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
export function pageKey(url: string): string {
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

/** A link's label: its visible text, else its aria-label or title. */
function linkLabel(attributes: string, inner: string): string {
  const text = visibleText(inner).replace(/\s+/g, ' ').trim();
  const aria =
    /aria-label\s*=\s*"([^"]{1,120})"/i.exec(attributes)?.[1] ??
    /title\s*=\s*"([^"]{1,120})"/i.exec(attributes)?.[1] ??
    '';
  return (text || aria).slice(0, 120);
}

/** Same-site pages a fetched page links to, label and URL, in page order, at most MAX_SITE_LINKS: the page itself, files and non-pages left out. */
function siteLinks(
  html: string,
  pageUrl: string,
): { label: string; url: URL }[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const site = siteOf(base.hostname);
  const seen = new Set([pageKey(base.href.replace(/[#?].*$/, ''))]);
  const links: { label: string; url: URL }[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    if (seen.size > MAX_SITE_LINKS) break;
    const href = HREF.exec(match[1]);
    const raw = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
    if (!raw || raw.startsWith('#')) continue;
    if (/^(mailto|tel|javascript|data|sms|whatsapp):/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw.replace(/&amp;/g, '&'), base);
    } catch {
      continue;
    }
    if (
      !/^https?:$/.test(url.protocol) ||
      siteOf(url.hostname) !== site ||
      NOT_HTML.test(url.pathname)
    ) {
      continue;
    }
    url.hash = '';
    const key = pageKey(url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ label: linkLabel(match[1], match[2]), url });
  }
  return links;
}

/** The about links among a page's same-site links: label or path about the company or its people. */
function aboutOf(links: readonly { label: string; url: URL }[]): string[] {
  return links
    .filter((link) => ABOUT.test(`${link.label} ${link.url.pathname}`))
    .map((link) => link.url.href);
}

/** Same-site pages a fetched page links to whose label or path is about the company or its people, in page order. */
export function aboutLinks(html: string, pageUrl: string): string[] {
  return aboutOf(siteLinks(html, pageUrl));
}

/** The walk's pages in order: homepage legal links not on the fixed list, the fixed paths, then about links not already listed. */
export function walkTargets(
  origin: string,
  links: readonly string[],
  maxPaths: number,
  about: readonly string[] = [],
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
  const listed = new Set([...extra, ...paths].map(pageKey));
  const people = about
    .filter((link) => !listed.has(pageKey(link)))
    .slice(0, MAX_ABOUT_LINKS);
  return [...extra, ...paths, ...people];
}

/** The row fields a candidate's pages are read against. */
type ProbeRow = CompanyNames & {
  companyNumber: string;
  postcode: string | null;
};

/** Whether a page showing the postcode names the company as its own: named, and not as one entry of a listing. */
function namedAsItself(host: string, text: string, row: ProbeRow): boolean {
  return (
    namesCompany(host, text, row) &&
    !isListingEntry(host, text, row.postcode ?? '', row)
  );
}

/** What a candidate's homepage proves, read off the page its URL served. */
export function readHomepage(
  row: ProbeRow,
  url: string,
  servedUrl: string,
  html: string,
  crowded: ReadonlySet<string>,
): CandidateProbe {
  let host = '';
  try {
    host = new URL(servedUrl).host.toLowerCase();
  } catch {
    // An unreadable served URL judges no host.
  }
  const text = visibleText(html);
  const links = siteLinks(html, servedUrl);
  const onAggregator = isDiscoveryAggregator(host, crowded);
  // A directory's numbers are its listings', not the site naming itself.
  const stated = onAggregator ? [] : statedOnPage(servedUrl, html);
  const crnFound = pageShowsCompanyNumber(html, row.companyNumber, stated);
  const postcodeFound = row.postcode
    ? pageHasPostcode(html, row.postcode)
    : false;
  return {
    // The URL we ASKED for, not the post-redirect one: that is what a visitor
    // clicks and what the sweep revalidates. The HOST is judged post-redirect,
    // because a URL that 301s into a directory is what it lands on.
    url,
    // The page actually PARSED — post-redirect — matching the walk. On a
    // redirecting candidate, `url` names a page the signals never came from.
    evidenceUrl: crnFound || postcodeFound ? servedUrl : null,
    crnFound,
    postcodeFound,
    // Named by the serving host too: a named domain that redirects to another
    // business serves that business's page.
    postcodeNamed: postcodeFound && namedAsItself(host, text, row),
    onAggregator,
    parked: looksParked(text),
    challenged: looksChallenged(text),
    siteLinks: links.length,
    thin: pageTooThin(text),
    legalLinks: legalLinks(html, servedUrl),
    aboutLinks: aboutOf(links),
    stated,
    pages: [readPage(servedUrl, text, row, stated)],
  };
}

/** What one walked page proves. */
export type WalkPage = {
  crnFound: boolean;
  postcodeFound: boolean;
  /** The page shows the postcode and names the company as its own: by the host that served it, or in its text, never as a listing's entry. */
  pageNamed: boolean;
  stated: StatedOnSite[];
  /** The page as the two-signal rule reads it. */
  read: PageRead;
};

/** What one walked page proves; null when it was served from a directory. */
export function readWalkPage(
  row: ProbeRow,
  pageUrl: string,
  html: string,
  crowded: ReadonlySet<string>,
): WalkPage | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  // A path that redirects into a register or directory lands on a page about
  // the company, which is not the site naming itself.
  if (isDiscoveryAggregator(host, crowded)) return null;
  const stated = statedOnPage(pageUrl, html);
  const postcodeFound = row.postcode
    ? pageHasPostcode(html, row.postcode)
    : false;
  const text = visibleText(html);
  return {
    crnFound: pageShowsCompanyNumber(html, row.companyNumber, stated),
    postcodeFound,
    // Judged on this page's own host: a walked path can redirect off the site.
    pageNamed: postcodeFound && namedAsItself(host, text, row),
    stated,
    read: readPage(pageUrl, text, row, stated),
  };
}

/** A walked page folded into its candidate: a number wins, and a named postcode beats an unnamed one. */
export function foldWalkPage(
  probe: CandidateProbe,
  pageUrl: string,
  page: WalkPage,
): CandidateProbe {
  if (page.crnFound) return { ...probe, crnFound: true, evidenceUrl: pageUrl };
  if (!page.postcodeFound || probe.postcodeNamed) return probe;
  const named = page.pageNamed;
  if (probe.postcodeFound && !named) return probe;
  return {
    ...probe,
    postcodeFound: true,
    postcodeNamed: named,
    evidenceUrl: pageUrl,
  };
}

/** Whether a candidate the plain walk read and found silent should be read again in a browser: its homepage links nowhere, or carries almost no text. Never a site that challenged the plain fetch. */
export function needsRender(probe: CandidateProbe): boolean {
  if (probe.onAggregator || probe.parked || probe.challenged) return false;
  if (probe.crnFound || (probe.postcodeFound && probe.postcodeNamed)) {
    return false;
  }
  return probe.siteLinks === 0 || probe.thin === true;
}
