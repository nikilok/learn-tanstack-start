/**
 * The sponsor register's names for a company, as the website selectors read
 * them: one column declaration, every selector's. No I/O.
 */

/**
 * Every register entry for the company joined as `p`, trading names
 * included: a site may use any. Constant SQL text, interpolated raw.
 */
export const SPONSOR_NAMES_COLUMN =
  'ARRAY(SELECT s.organisation_name FROM hmrc_company_mapping s WHERE s.company_number = p.company_number) AS sponsor_names';

/** A selected row's register entries; none when the column is NULL. */
export function sponsorNamesOf(row: Record<string, unknown>): string[] {
  return Array.isArray(row.sponsor_names)
    ? (row.sponsor_names as string[])
    : [];
}
