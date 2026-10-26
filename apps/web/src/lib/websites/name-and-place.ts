/**
 * The two-signal rule (R2-EO) for a site that states neither the company's
 * number nor its named registered postcode: an identity signal and a place
 * signal, both on the site. Sealed and measured before any build; see
 * publishable.ts for the figures. No I/O.
 */

import { type CompanyNames, hostNamer, namesCompany } from './company-naming';
import { pageHasExactLegalName } from './exact-legal-name';
import { type Officer, officerNamedIn } from './officer-names';
import {
  pagePostcodes,
  placePhrases,
  postcodeDistrict,
  textNamesPlace,
} from './place-signal';
import type { StatedNumber } from './stated-numbers';

/** Characters of a page's text the rule reads, as the measurement read them. */
export const PAGE_TEXT_CHARS = 60_000;

/** One fetched page as the rule reads it. */
export type PageRead = {
  /** The page as served, after redirects. */
  url: string;
  /** Visible text, whitespace collapsed, at most PAGE_TEXT_CHARS. */
  text: string;
  /** The page, or the host that served it, names the company. */
  named: boolean;
  /** Statutory company numbers the page states, whoever they belong to. */
  statedNumbers: string[];
  /** Postcodes read off the whole page. */
  postcodes: string[];
};

/** The row fields the rule reads. */
export type NameAndPlaceRow = CompanyNames & {
  companyNumber: string;
  postcode: string | null;
  /** Towns the sponsor register lists the company at. */
  registerTowns: readonly string[];
  /** The registered office locality. */
  locality: string | null;
};

/** What the rule says about one candidate site. */
export type SiteVerdict =
  | { kind: 'proved'; evidenceUrl: string }
  | { kind: 'not_proved' }
  /** Only the company's officers can decide it now. */
  | { kind: 'needs_officers' };

const NOT_PROVED: SiteVerdict = { kind: 'not_proved' };

/** A fetched page as the rule reads it, from its visible text and the numbers it states. */
export function readPage(
  servedUrl: string,
  visible: string,
  names: CompanyNames,
  stated: readonly StatedNumber[],
): PageRead {
  const flat = visible.replace(/\s+/g, ' ').trim();
  let host = '';
  try {
    host = new URL(servedUrl).hostname.toLowerCase();
  } catch {
    // An unreadable URL names no host.
  }
  return {
    url: servedUrl,
    text: flat.slice(0, PAGE_TEXT_CHARS),
    named: namesCompany(host, flat, names),
    statedNumbers: stated.map((s) => s.companyNumber),
    postcodes: pagePostcodes(flat),
  };
}

/** Whether the pages show one of the company's places: a town as whole words, or a postcode in its registered district. */
function showsPlace(row: NameAndPlaceRow, pages: readonly PageRead[]): boolean {
  const text = pages.map((page) => page.text).join(' \n ');
  if (textNamesPlace(text, placePhrases(row.registerTowns, row.locality))) {
    return true;
  }
  const district = postcodeDistrict(row.postcode ?? '');
  return (
    district !== '' &&
    pages.some((page) =>
      page.postcodes.some(
        (postcode) => postcodeDistrict(postcode) === district,
      ),
    )
  );
}

/** Whether the site's domain or any of its pages names the company. */
function siteNamesCompany(
  row: NameAndPlaceRow,
  siteUrl: string,
  pages: readonly PageRead[],
): boolean {
  let host = '';
  try {
    host = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    // An unreadable URL names no host.
  }
  return hostNamer(row)(host) || pages.some((page) => page.named);
}

/**
 * The rule on one candidate site: the exact registered name on a page stating
 * no other company's number, or an officer named on a site that names the
 * company; and a place of the company's. `officers` is undefined until looked
 * up, and is asked for only when it decides the verdict.
 */
export function judgeSite(
  row: NameAndPlaceRow,
  site: { url: string; pages: readonly PageRead[] },
  officers?: readonly Officer[],
): SiteVerdict {
  const { pages } = site;
  if (pages.length === 0 || !showsPlace(row, pages)) return NOT_PROVED;
  const namePage = pages.find(
    (page) =>
      pageHasExactLegalName(page.text, row.companyName) &&
      page.statedNumbers.every((number) => number === row.companyNumber),
  );
  if (namePage) return { kind: 'proved', evidenceUrl: namePage.url };
  if (!siteNamesCompany(row, site.url, pages)) return NOT_PROVED;
  if (!officers) return { kind: 'needs_officers' };
  // The pages joined as one text, as the rule was measured.
  const text = pages.map((page) => page.text).join(' \n ');
  if (!officerNamedIn(text, officers)) return NOT_PROVED;
  const officerPage =
    pages.find((page) => officerNamedIn(page.text, officers)) ?? pages[0];
  return { kind: 'proved', evidenceUrl: officerPage.url };
}
