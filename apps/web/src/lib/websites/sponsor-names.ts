/**
 * The sponsor register's names for a company, as the website selectors read
 * them: one column declaration, every selector's. No I/O.
 */

/** The column's name, which the driver keys every row by. */
export const SPONSOR_NAMES_KEY = 'sponsor_names';

/** Every register entry for the company whose number `companyNumber` refers to, trading names included: a site may use any. Constant SQL text, interpolated raw. */
export function sponsorNamesColumnFor(companyNumber: string): string {
  return `ARRAY(SELECT s.organisation_name FROM hmrc_company_mapping s WHERE s.company_number = ${companyNumber}) AS ${SPONSOR_NAMES_KEY}`;
}

/** Every register entry for the company joined as `p`. */
export const SPONSOR_NAMES_COLUMN = sponsorNamesColumnFor('p.company_number');

/** A selected row's register entries; none when the row carries no such column. */
export function sponsorNamesOf(row: Record<string, unknown>): string[] {
  const names = row[SPONSOR_NAMES_KEY];
  return Array.isArray(names) ? (names as string[]) : [];
}
