/**
 * The sponsor register's towns for a company, as the website selectors read
 * them: one column declaration, every selector's. No I/O.
 */

/** The column's name, which the driver keys every row by. */
export const SPONSOR_TOWNS_KEY = 'register_towns';

/** Every town the register lists the company whose number `companyNumber` refers to at. Constant SQL text, interpolated raw. */
export function sponsorTownsColumnFor(companyNumber: string): string {
  return `ARRAY(SELECT DISTINCT t.town_city FROM hmrc_company_mapping m JOIN hmrc_skilled_workers t ON t.organisation_name = m.organisation_name WHERE m.company_number = ${companyNumber} AND t.town_city IS NOT NULL) AS ${SPONSOR_TOWNS_KEY}`;
}

/** Every register town for the company joined as `p`. */
export const SPONSOR_TOWNS_COLUMN = sponsorTownsColumnFor('p.company_number');

/** A selected row's register towns; none when the row carries no such column. */
export function sponsorTownsOf(row: Record<string, unknown>): string[] {
  const towns = row[SPONSOR_TOWNS_KEY];
  return Array.isArray(towns)
    ? towns.filter((town): town is string => typeof town === 'string')
    : [];
}
