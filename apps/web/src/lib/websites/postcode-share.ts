/**
 * The postcode share: how many mapped companies are registered at a company's
 * postcode. The publish gate admits a search-found `postcode_on_page` row only
 * when its share is low (publishable.ts), so this is the one definition, and it
 * is exactly the one the 2026-10-19 precision sample was stratified by:
 *
 *   - DISTINCT company numbers in hmrc_company_mapping joined to
 *     companies_house_profiles, so a company mapped from several register
 *     names counts once;
 *   - postcodes compared upper-cased with all whitespace removed;
 *   - an empty postcode matches nothing.
 *
 * The company counts itself when mapped, so a share of 1 means it is alone at
 * its postcode. NULL means it has no postcode or no mapped company is
 * registered there, and NULL never publishes.
 *
 * Stored on the row (company_websites.postcode_share) rather than computed in
 * the gate, which runs once per candidate row in the "Has website" listing. On
 * prod (2026-10-20) one unindexed evaluation scanned every profile (~170ms),
 * and a stand-in for an indexed one still took that listing to ~1.1s, against
 * ~0.5s with a stored column. Every sweep run refreshes it (sweep-websites.ts).
 */

/**
 * Every website row's current share, as `(company_number, share)`. A plain
 * string so the regex keeps its backslash: inside a tagged template `'\s+'`
 * cooks to `'s+'`, which strips the letter s and leaves the spaces.
 */
export const POSTCODE_SHARES_SQL = String.raw`
  WITH postcodes AS (
    SELECT company_number,
           upper(regexp_replace(postal_code, '\s+', '', 'g')) AS postcode
    FROM companies_house_profiles
  ),
  shares AS (
    SELECT pc.postcode, count(DISTINCT m.company_number)::int AS share
    FROM hmrc_company_mapping m
    JOIN postcodes pc ON pc.company_number = m.company_number
    WHERE pc.postcode <> ''
    GROUP BY pc.postcode
  )
  SELECT w.company_number, s.share
  FROM company_websites w
  LEFT JOIN postcodes pc ON pc.company_number = w.company_number
  LEFT JOIN shares s ON s.postcode = pc.postcode`;

/** Rows whose stored share differs from the fresh one; shared so a dry run counts what a live run writes. */
const MOVED = `w.company_number = fresh.company_number
    AND w.postcode_share IS DISTINCT FROM fresh.share`;

/** Most rows one refresh statement writes. The first fill moves every row, and
 *  one statement that failed would be retried whole by every later run. */
export const REFRESH_BATCH_ROWS = 20_000;

/** Batches a refresh may take before it gives up: far more than the table
 *  holds, so reaching it means the shares are not settling. */
export const MAX_REFRESH_BATCHES = 50;

type Query = (text: string) => Promise<Record<string, unknown>[]>;

/**
 * Bring every row's postcode_share up to date, writing only the rows whose
 * share moved, at most REFRESH_BATCH_ROWS per statement so a failure keeps the
 * batches before it. Returns how many rows moved; a dry run counts them and
 * writes nothing.
 */
export function makeRefreshPostcodeShares(query: Query) {
  return async (dryRun: boolean): Promise<number> => {
    if (dryRun) {
      const [row] = await query(`WITH fresh AS (${POSTCODE_SHARES_SQL})
  SELECT count(*)::int AS moved FROM company_websites w, fresh
  WHERE ${MOVED}`);
      return Number(row?.moved ?? 0);
    }
    let total = 0;
    for (let batch = 0; batch < MAX_REFRESH_BATCHES; batch++) {
      const [row] = await query(`WITH fresh AS (${POSTCODE_SHARES_SQL}),
  batch AS (
    SELECT fresh.company_number, fresh.share FROM company_websites w, fresh
    WHERE ${MOVED}
    ORDER BY fresh.company_number
    LIMIT ${REFRESH_BATCH_ROWS}
  ),
  moved AS (
    UPDATE company_websites w SET postcode_share = batch.share
    FROM batch
    WHERE w.company_number = batch.company_number
    RETURNING 1
  )
  SELECT count(*)::int AS moved FROM moved`);
      const moved = Number(row?.moved ?? 0);
      total += moved;
      if (moved < REFRESH_BATCH_ROWS) return total;
    }
    throw new Error(
      `postcode shares still moving after ${MAX_REFRESH_BATCHES} batches`,
    );
  };
}
