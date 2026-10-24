/**
 * The url whose host names the company: the naming rule's host check
 * (company-naming.ts) run on each row's url, stored as the url it passed for.
 * The publish gate admits a widely shared postcode only through it, and only
 * while it still equals the row's url, so a url any writer changes stops
 * counting at once and needs no writer to clear it. Every sweep run refreshes
 * it (sweep-websites.ts), as it does the postcode share.
 *
 * Stored rather than checked in the gate because the check is code, not SQL:
 * spelling it twice would be two rules to keep in agreement.
 */

import { hostNamer } from './company-naming';
import { SPONSOR_NAMES_COLUMN, sponsorNamesOf } from './sponsor-names';

/** Every row holding a url or a named url, with its company's names. */
export const NAMED_URL_ROWS_SQL = `
  SELECT w.company_number, w.url, w.named_url,
    coalesce(p.company_name, '') AS company_name,
    ${SPONSOR_NAMES_COLUMN}
  FROM company_websites w
  LEFT JOIN companies_house_profiles p USING (company_number)
  WHERE w.url IS NOT NULL OR w.named_url IS NOT NULL`;

/** Most rows one write statement carries. */
export const NAMED_URL_BATCH_ROWS = 5_000;

/** A url's company and names, as the check reads them. */
export type NamedUrlInput = {
  url: string;
  companyName: string;
  sponsorNames: string[];
};

/** The url when its host names the company, else null; null for a url that does not parse. */
export function namedUrlOf(row: NamedUrlInput): string | null {
  let host: string;
  try {
    host = new URL(row.url).hostname;
  } catch {
    return null;
  }
  const named = hostNamer({
    companyName: row.companyName,
    sponsorNames: row.sponsorNames,
  });
  return named(host) ? row.url : null;
}

type Query = (
  text: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

/**
 * Bring every row's named_url up to date, writing only the rows whose value
 * moved, at most NAMED_URL_BATCH_ROWS per statement. Returns how many rows
 * moved; a dry run counts them and writes nothing.
 */
export function makeRefreshNamedUrls(query: Query) {
  return async (dryRun: boolean): Promise<number> => {
    const moved: { companyNumber: string; namedUrl: string | null }[] = [];
    for (const row of await query(NAMED_URL_ROWS_SQL)) {
      const url = row.url as string | null;
      const fresh = url
        ? namedUrlOf({
            url,
            companyName: row.company_name as string,
            sponsorNames: sponsorNamesOf(row),
          })
        : null;
      if (fresh !== ((row.named_url as string | null) ?? null)) {
        moved.push({
          companyNumber: row.company_number as string,
          namedUrl: fresh,
        });
      }
    }
    if (dryRun) return moved.length;
    for (let i = 0; i < moved.length; i += NAMED_URL_BATCH_ROWS) {
      const batch = moved.slice(i, i + NAMED_URL_BATCH_ROWS);
      await query(
        `UPDATE company_websites w SET named_url = v.named_url
  FROM unnest($1::text[], $2::text[]) AS v(company_number, named_url)
  WHERE w.company_number = v.company_number`,
        [batch.map((m) => m.companyNumber), batch.map((m) => m.namedUrl)],
      );
    }
    return moved.length;
  };
}
