/**
 * Whether a page shows the company as one entry of a listing, which names the
 * company and prints its postcode without being its site. No I/O.
 *
 * An exhibitor list, a supplier directory or a member page gives each business
 * its own address and its own website. So where the page gives the company
 * another website beside its postcode, and many other businesses their own
 * websites beside theirs, it is a listing. A company's own site may give its
 * other domains and list its branches, and cites only a few other bodies, such
 * as its regulators, with their addresses and sites.
 */

import {
  type CompanyNames,
  hostNamer,
  registrableDomain,
} from './company-naming';
import {
  POSTCODE_INWARD,
  POSTCODE_OUTWARD,
  postcodePattern,
  postcodeText,
} from './extract';
import { isAggregatorHost } from './page-signals';

/** Other businesses, by their postcodes, a listing must give their own websites beside: more than an own page's regulators. */
export const LISTING_OTHER_SITES = 5;

/** The most characters between a postcode and the website a listing gives beside it. */
export const NEAR_POSTCODE = 200;

/** Mail providers of personal addresses, whose domains are no business's own site. */
const CONSUMER_MAIL = new Set([
  'aol.com',
  'btinternet.com',
  'gmail.com',
  'gmx.com',
  'googlemail.com',
  'hotmail.co.uk',
  'hotmail.com',
  'icloud.com',
  'live.co.uk',
  'live.com',
  'mail.com',
  'me.com',
  'msn.com',
  'ntlworld.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'sky.com',
  'talktalk.net',
  'virginmedia.com',
  'yahoo.co.uk',
  'yahoo.com',
]);

/** Whether a site is no business's own: a mail provider, a social network or a directory. */
function isPlatform(site: string): boolean {
  return CONSUMER_MAIL.has(site) || isAggregatorHost(site);
}

/** Any UK postcode, bounded, its two codes at most one space apart. */
const ANY_POSTCODE = new RegExp(
  `(?<![A-Z0-9])${POSTCODE_OUTWARD} ?${POSTCODE_INWARD}(?![A-Z0-9])`,
  'g',
);

/**
 * A domain as a page writes one, alone, in a URL or after an email's `@`:
 * labels, then a top-level domain of letters. Only a whole dotted token, so
 * never part of a longer one, nor an email's dotted name before its `@`, nor a
 * what3words address after its `///`.
 */
const WRITTEN_SITE =
  /(?<![A-Z0-9.-]|\/{3})((?:[A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,24})(?![A-Z0-9-]|\.[A-Z0-9]| ?@)/g;

/** A postcode the page writes, and whether it is the company's own. */
type Written = { index: number; code: string; own: boolean };

/** The postcode a site is written beside: the nearest, within NEAR_POSTCODE; null when none is. Postcodes are in page order. */
function besidePostcode(
  postcodes: readonly Written[],
  index: number,
): Written | null {
  // The first postcode at or after the site, by binary search.
  let after = 0;
  let end = postcodes.length;
  while (after < end) {
    const middle = (after + end) >> 1;
    if (postcodes[middle].index < index) after = middle + 1;
    else end = middle;
  }
  let best: Written | null = null;
  for (const postcode of [postcodes[after - 1], postcodes[after]]) {
    if (!postcode) continue;
    const distance = Math.abs(postcode.index - index);
    if (
      distance <= NEAR_POSTCODE &&
      (!best || distance < Math.abs(best.index - index))
    ) {
      best = postcode;
    }
  }
  return best;
}

/** Whether the page lists the company among other businesses: it gives the company, and other businesses, websites beside their postcodes. */
export function isListingEntry(
  servedHost: string,
  text: string,
  postcode: string,
  names: CompanyNames,
): boolean {
  const named = hostNamer(names);
  if (named(servedHost)) return false;
  const pattern = postcodePattern(postcode, 'g');
  if (!pattern) return false;
  // Runs of blank lines count as one boundary, as a reader sees the page; one
  // optional space before a newline keeps the match linear, as postcodeText
  // has already collapsed every run of spaces.
  const page = postcodeText(text).replace(/ ?\n[\n ]*/g, '\n');
  const own = new Set([...page.matchAll(pattern)].map((m) => m.index));
  const postcodes = [...page.matchAll(ANY_POSTCODE)].map((m) => ({
    index: m.index,
    code: m[0].replace(' ', ''),
    own: own.has(m.index),
  }));
  // Fewer than the company's postcode and the others' can list nothing; most pages stop here.
  if (new Set(postcodes.map((p) => p.code)).size <= LISTING_OTHER_SITES) {
    return false;
  }
  // Sites at the domain they are registered under: a shop or CDN subdomain is
  // the platform's, and the serving site's own pages are no other business.
  const served = registrableDomain(servedHost);
  let givesCompany = false;
  /** Each other business's postcode, and the sites written beside it. */
  const besideOthers = new Map<string, Set<string>>();
  for (const m of page.matchAll(WRITTEN_SITE)) {
    const beside = besidePostcode(postcodes, m.index);
    const site = registrableDomain(m[1]);
    if (!beside || site === served || isPlatform(site)) continue;
    const namesIt = named(site);
    if (beside.own) givesCompany ||= namesIt;
    else if (!namesIt) {
      besideOthers.set(
        beside.code,
        (besideOthers.get(beside.code) ?? new Set()).add(site),
      );
    }
  }
  // A business's own site is beside its postcode alone: one beside several is
  // a regulator's or a member body's. A business giving two sites counts once.
  const entries = new Map<string, number>();
  for (const sites of besideOthers.values()) {
    for (const site of sites) entries.set(site, (entries.get(site) ?? 0) + 1);
  }
  const others = [...besideOthers.values()].filter((sites) =>
    [...sites].some((site) => entries.get(site) === 1),
  );
  return givesCompany && others.length >= LISTING_OTHER_SITES;
}
