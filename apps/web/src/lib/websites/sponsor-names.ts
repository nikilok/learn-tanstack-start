/**
 * The sponsor register's names for a company, as the website selectors read
 * them: one column declaration, every selector's. No I/O.
 */

/** The column's name, which the driver keys every row by. */
export const SPONSOR_NAMES_KEY = 'sponsor_names';

/**
 * Every register entry for the company joined as `p`, trading names
 * included: a site may use any. Constant SQL text, interpolated raw.
 */
export const SPONSOR_NAMES_COLUMN = `ARRAY(SELECT s.organisation_name FROM hmrc_company_mapping s WHERE s.company_number = p.company_number) AS ${SPONSOR_NAMES_KEY}`;

/** A selected row's register entries; none when the row carries no such column. */
export function sponsorNamesOf(row: Record<string, unknown>): string[] {
  const names = row[SPONSOR_NAMES_KEY];
  return Array.isArray(names) ? (names as string[]) : [];
}
