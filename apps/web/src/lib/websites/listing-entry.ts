/**
 * Whether a page shows the company as one entry of a listing, which names the
 * company and prints its postcode without being its site. No I/O.
 *
 * An exhibitor list, a supplier directory or a member page gives each business
 * its own address and its own website. So where the page writes several
 * businesses' postcodes and gives the company another website beside its
 * postcode, it is a listing. Both are needed: a company's own site may give its
 * other domains, and a chain's site lists many branches.
 */

import {
  type CompanyNames,
  hostNamesAny,
  registrableDomain,
} from './company-naming';
import { postcodePattern, postcodeText } from './extract';

/** Distinct postcodes a page must write to list several businesses. */
export const LISTING_POSTCODES = 3;

/** The most characters between the company's postcode and the website a listing gives it. */
export const NEAR_POSTCODE = 200;

/** Any UK postcode, bounded, its two codes at most one space apart. */
const ANY_POSTCODE =
  /(?<![A-Z0-9])[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![A-Z0-9])/g;

/** A domain as a page writes one, alone, in a URL or after an email's `@`: labels, then a top-level domain of letters. */
const WRITTEN_SITE =
  /(?<![A-Z0-9.-])((?:[A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,24})(?![A-Z0-9-])/g;

/** Whether the page lists the company among other businesses, giving it another website beside its postcode. */
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
  const postcodes = new Set(
    [...page.matchAll(ANY_POSTCODE)].map((m) => m[0].replace(' ', '')),
  );
  if (postcodes.size < LISTING_POSTCODES) return false;
  const at = [...page.matchAll(pattern)].map((m) => m.index);
  // At the domain a site is registered under: a shop or CDN subdomain is the
  // platform's, and the serving site's own pages name no one, as its host does not.
  return [...page.matchAll(WRITTEN_SITE)].some(
    (m) =>
      at.some((index) => Math.abs(index - m.index) <= NEAR_POSTCODE) &&
      hostNamesAny(registrableDomain(m[1]), names),
  );
}
