/**
 * Whether a page shows the company as one entry of a listing, which names the
 * company and prints its postcode without being its site. No I/O.
 *
 * An exhibitor list, a supplier directory or a member page gives each business
 * its own address and its own website. So where the page gives the company
 * another website beside its postcode, and other businesses their own websites
 * beside theirs, it is a listing. A company's own site may give its other
 * domains and list its branches, but it gives no other business a site.
 */

import {
  type CompanyNames,
  hostNamesAny,
  registrableDomain,
} from './company-naming';
import { postcodePattern, postcodeText } from './extract';

/** Distinct postcodes a page must write to list several businesses. */
export const LISTING_POSTCODES = 3;

/** Other businesses a listing must give their own websites, beside their own postcodes. */
export const LISTING_OTHER_SITES = 2;

/** The most characters between a postcode and the website a listing gives beside it. */
export const NEAR_POSTCODE = 200;

/** Any UK postcode, bounded, its two codes at most one space apart. */
const ANY_POSTCODE =
  /(?<![A-Z0-9])[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![A-Z0-9])/g;

/** A domain as a page writes one, alone, in a URL or after an email's `@`: labels, then a top-level domain of letters. */
const WRITTEN_SITE =
  /(?<![A-Z0-9.-])((?:[A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,24})(?![A-Z0-9-])/g;

/** A postcode the page writes, and whether it is the company's own. */
type Written = { index: number; own: boolean };

/** The postcode a site is written beside: the nearest, within NEAR_POSTCODE; null when none is. */
function besidePostcode(
  postcodes: readonly Written[],
  index: number,
): Written | null {
  let best: Written | null = null;
  for (const postcode of postcodes) {
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
  if (hostNamesAny(servedHost, names)) return false;
  const pattern = postcodePattern(postcode, 'g');
  if (!pattern) return false;
  // Runs of blank lines count as one boundary, as a reader sees the page.
  const page = postcodeText(text).replace(/\s*\n\s*/g, '\n');
  const all = [...page.matchAll(ANY_POSTCODE)];
  const distinct = new Set(all.map((m) => m[0].replace(' ', '')));
  if (distinct.size < LISTING_POSTCODES) return false;
  const own = new Set([...page.matchAll(pattern)].map((m) => m.index));
  const postcodes = all.map((m) => ({ index: m.index, own: own.has(m.index) }));
  // Sites at the domain they are registered under: a shop or CDN subdomain is
  // the platform's, and the serving site's own pages are no other business.
  const served = registrableDomain(servedHost);
  let givesCompany = false;
  const otherSites = new Set<string>();
  for (const m of page.matchAll(WRITTEN_SITE)) {
    const beside = besidePostcode(postcodes, m.index);
    const site = registrableDomain(m[1]);
    if (!beside || site === served) continue;
    const namesIt = hostNamesAny(site, names);
    if (beside.own) givesCompany ||= namesIt;
    else if (!namesIt) otherSites.add(site);
  }
  return givesCompany && otherSites.size >= LISTING_OTHER_SITES;
}
