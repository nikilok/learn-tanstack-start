/**
 * Database wiring for the fallback job. Every write is guarded on the row
 * still being what the job read, an empty search row it has not settled, so a
 * row another job changed meanwhile is left alone.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import { evidenceConfidence } from './decide';
import type { FallbackPick, FallbackRow } from './fallback';
import { CURRENT_WALK_VERSION } from './rewalk';
import { type Shard, WHOLE_SET } from './shard';
import { SPONSOR_NAMES_COLUMN, sponsorNamesOf } from './sponsor-names';
import { SPONSOR_TOWNS_COLUMN, sponsorTownsOf } from './sponsor-towns';

type Sql = NeonQueryFunction<false, false>;

/**
 * The rows the fallback reads: search rows the current walk read and left
 * empty, for a company the register shows as active, not yet settled. One
 * declaration for the selector and the count. Constant SQL text, interpolated
 * raw; the row is `w`, its profile `p`.
 */
const FALLBACK_ROWS = `w.source = 'search' AND w.status = 'none' AND w.evidence = 'none'
  AND w.url IS NULL AND jsonb_typeof(w.candidates) = 'array'
  AND w.walk_version = ${CURRENT_WALK_VERSION}
  AND w.fallback_checked_at IS NULL
  AND p.company_status = 'active'`;

/** SIC descriptions by code. */
export type SicDescriptions = Readonly<Record<string, string>>;

/** A row's SIC codes as their descriptions, a code without one as itself. */
export function tradesOf(
  codes: unknown,
  descriptions: SicDescriptions,
): string[] {
  if (!Array.isArray(codes)) return [];
  return codes
    .filter((code): code is string => typeof code === 'string')
    .map((code) => descriptions[code] ?? code);
}

/** The fallback's rows in company-number order, sliced by the same bucket as discovery. */
export function makeSelectFallback(
  sql: Sql,
  descriptions: SicDescriptions,
  shard: Shard = WHOLE_SET,
) {
  return async (maxRows: number): Promise<FallbackRow[]> => {
    const rows = await sql`
      SELECT w.company_number, w.candidates,
        coalesce(p.company_name, '') AS company_name, p.locality, p.postal_code,
        to_char(p.date_of_creation, 'YYYY-MM-DD') AS incorporated, p.sic_codes,
        ${sql.unsafe(SPONSOR_NAMES_COLUMN)},
        ${sql.unsafe(SPONSOR_TOWNS_COLUMN)}
      FROM company_websites w
      JOIN companies_house_profiles p USING (company_number)
      WHERE ${sql.unsafe(FALLBACK_ROWS)}
        AND mod(
          ('x' || left(md5(w.company_number), 7))::bit(28)::int,
          ${shard.count}::int
        ) = ${shard.index}::int
      ORDER BY w.company_number
      LIMIT ${maxRows}
    `;
    return rows.map((r) => ({
      companyNumber: r.company_number as string,
      companyName: (r.company_name as string | null) ?? '',
      sponsorNames: sponsorNamesOf(r),
      registerTowns: sponsorTownsOf(r),
      locality: (r.locality as string | null) ?? null,
      postcode: (r.postal_code as string | null) ?? null,
      incorporated: (r.incorporated as string | null) ?? null,
      trades: tradesOf(r.sic_codes, descriptions),
      candidates: Array.isArray(r.candidates) ? (r.candidates as string[]) : [],
    }));
  };
}

/**
 * Write a kept choice as `assessed` and settle the row. `checked_at` is
 * cleared so the sweep confirms the site before it renders, as every
 * discovery leaves it.
 */
export function makeWritePick(sql: Sql) {
  return async (row: FallbackRow, pick: FallbackPick): Promise<boolean> => {
    const updated = await sql`
      UPDATE company_websites SET
        url                 = ${pick.url},
        link_url            = ${pick.linkUrl},
        evidence_url        = NULL,
        status              = 'verified',
        evidence            = 'assessed',
        confidence          = ${evidenceConfidence('assessed').toFixed(3)}::numeric,
        checked_at          = NULL,
        failure_count       = 0,
        fallback_checked_at = now()
      WHERE company_number = ${row.companyNumber}
        AND source = 'search' AND status = 'none' AND evidence = 'none'
        AND url IS NULL AND fallback_checked_at IS NULL
      RETURNING company_number
    `;
    return updated.length > 0;
  };
}

/** Settle a row without a choice. */
export function makeMarkSettled(sql: Sql) {
  return async (row: FallbackRow): Promise<void> => {
    await sql`
      UPDATE company_websites SET fallback_checked_at = now()
      WHERE company_number = ${row.companyNumber}
        AND source = 'search' AND status = 'none' AND evidence = 'none'
        AND url IS NULL AND fallback_checked_at IS NULL
    `;
  };
}

/** Rows the fallback has still to settle, every shard's, for the run summary. */
export function makeFallbackRemaining(sql: Sql) {
  return async (): Promise<number> => {
    const [r] = await sql`
      SELECT count(*)::int AS remaining
      FROM company_websites w
      JOIN companies_house_profiles p USING (company_number)
      WHERE ${sql.unsafe(FALLBACK_ROWS)}
    `;
    return Number(r.remaining);
  };
}
