import { poolFor } from './licences';
import type { CompanyLicence, CompanyPageRow } from './page-rows';

/** A company page's licence numbers and confirmed website, as getCompanyExtras returns them. */
export type CompanyExtras = {
  licenceNumbers: string[];
  website: string | null;
};

/** Which extras a page has, without their values: enough to hold their space while they load. */
export type ExtrasOutline = {
  licenceNumberCount: number;
  hasWebsite: boolean;
};

/** Every distinct licence number across rows, in row order: a company can hold one per licence row. */
function distinctLicenceNumbers(
  rows: Pick<CompanyPageRow, 'sponsorLicenceNumber'>[],
): string[] {
  const numbers = rows
    .map((row) => row.sponsorLicenceNumber)
    .filter((n): n is string => Boolean(n));
  return [...new Set(numbers)];
}

/** The outline of a pooled row set's extras, counts and flags only: its licence numbers, and the website of its first row's company. */
function extrasOutline(pool: CompanyPageRow[]): ExtrasOutline {
  return {
    licenceNumberCount: distinctLicenceNumbers(pool).length,
    hasWebsite: Boolean(pool[0]?.websiteUrl),
  };
}

/** A page row narrowed to the fields the page payload carries, field by field, so a column added to the query never rides along. */
function toCompanyLicence(row: CompanyPageRow): CompanyLicence {
  return {
    slugId: row.slugId,
    organisationName: row.organisationName,
    companyNumber: row.companyNumber,
    typeRating: row.typeRating,
    route: row.route,
  };
}

/** The payload a found company page carries for its pooled rows: the licence rows and the outline of the extras, never the extras themselves. */
export function companyPagePayload(pool: CompanyPageRow[]): {
  licences: CompanyLicence[];
  extras: ExtrasOutline;
} {
  return {
    licences: pool.map(toCompanyLicence),
    extras: extrasOutline(pool),
  };
}

/**
 * The extras of the page a visitor is on, from the slug's current rows. Its
 * licence numbers come from the rows it rendered (by slugId), less any since
 * mapped to a company other than the one it shows; a page showing no company
 * keeps every row it rendered. Its website is the one looked up for that
 * company, and none without one. The page is a cached snapshot, so neither may
 * follow the slug to whichever company now leads it.
 */
export function pageExtras(
  rows: CompanyPageRow[],
  page: { slugIds: readonly string[]; companyNumber: string | null },
  companyWebsite: string | null,
): CompanyExtras {
  const rendered = new Set(page.slugIds);
  const own = rows.filter((row) => rendered.has(row.slugId));
  const pool =
    page.companyNumber === null ? own : poolFor(own, page.companyNumber);
  return {
    licenceNumbers: distinctLicenceNumbers(pool),
    website: page.companyNumber === null ? null : companyWebsite,
  };
}

/**
 * Whether a page should request its extras: when the outline promises either,
 * or when the page shows a company its primary row was not mapped to when the
 * outline was built, so the outline could not see that company's website.
 */
export function extrasWanted(
  outline: ExtrasOutline,
  pageCompany: string | null,
  primaryRowCompany: string | null,
): boolean {
  if (outline.licenceNumberCount > 0 || outline.hasWebsite) return true;
  return pageCompany !== null && pageCompany !== primaryRowCompany;
}

/**
 * The company a page shows, which its extras must belong to: the Companies
 * House profile's number (the page's Registration No.), else the primary row's
 * mapping, else none. The profile leads because a first visit can resolve it
 * before the mapping row records it.
 */
export function pageCompanyNumber(
  profileNumber: string | null | undefined,
  primaryRowNumber: string | null | undefined,
): string | null {
  return profileNumber || primaryRowNumber || null;
}
