/**
 * Database wiring for the re-walk. Every write is guarded on the row still
 * holding what the re-walk read, so a row another job changed meanwhile is
 * left alone, and nothing here can lower a row's evidence.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import type { DiscoveryOutcome } from './discover';
import {
  CURRENT_WALK_VERSION,
  MAX_WALK_ATTEMPTS,
  type RewalkRow,
} from './rewalk';
import { type Shard, WHOLE_SET } from './shard';
import { SPONSOR_NAMES_COLUMN, sponsorNamesOf } from './sponsor-names';
import { SPONSOR_TOWNS_COLUMN, sponsorTownsOf } from './sponsor-towns';
import { dedupeStated, type StatedOnSite } from './stated-numbers';

type Sql = NeonQueryFunction<false, false>;

/** Which settled rows to re-walk. */
export type RewalkSelection = {
  shard?: Shard;
  /** Restrict to one kind of row; registry rows are walked only when asked for. */
  evidence?: 'none' | 'postcode_on_page' | 'registry';
  /** A seeded random sample instead of the resumable order; for dry-run measurement only. */
  seed?: string;
  /** Also take rows the current walk last read before this date or time: UTC, as `walked_at` is stored, so the two compare on one clock. */
  rereadBefore?: string;
};

/** The settled rows of each kind the re-walk reads. Constant SQL text, interpolated raw; the row is `w`. */
const SETTLED: Record<NonNullable<RewalkSelection['evidence']>, string> = {
  none: `(w.source = 'search' AND w.evidence = 'none' AND w.status = 'none'
    AND w.url IS NULL AND jsonb_typeof(w.candidates) = 'array')`,
  postcode_on_page: `(w.source = 'search' AND w.evidence = 'postcode_on_page'
    AND w.status IN ('verified', 'unreachable') AND w.url IS NOT NULL)`,
  registry: `(w.source <> 'search' AND w.evidence = 'registry'
    AND w.status IN ('verified', 'unreachable') AND w.url IS NOT NULL)`,
};

/** The rows a selection takes: the kind asked for, else the two search kinds, so registry rows only when asked for. One declaration for both selectors and the count. */
function settledRows(evidence?: RewalkSelection['evidence']): string {
  const kinds = evidence ? [evidence] : (['none', 'postcode_on_page'] as const);
  return `(${kinds.map((kind) => SETTLED[kind]).join(' OR ')})`;
}

/**
 * A row the current walk has not read, or last read before the cutoff. One
 * declaration for the resumable selector and the count; a seeded sample binds
 * no cutoff, so it cannot take the marker. Constant SQL text, interpolated
 * raw; the row is `w`, the cutoff `reread.cutoff`.
 */
const UNREAD = `(w.walk_version IS NULL OR w.walk_version < ${CURRENT_WALK_VERSION}
  OR w.walked_at < reread.cutoff)`;

/** Rows from the database, typed. */
function toRows(rows: Record<string, unknown>[]): RewalkRow[] {
  return rows.map((r) => ({
    companyNumber: r.company_number as string,
    companyName: (r.company_name as string | null) ?? '',
    sponsorNames: sponsorNamesOf(r),
    postcode: (r.postal_code as string | null) ?? null,
    registerTowns: sponsorTownsOf(r),
    locality: (r.locality as string | null) ?? null,
    evidence: r.evidence as RewalkRow['evidence'],
    source: (r.source as string | null) ?? 'search',
    url: (r.url as string | null) ?? null,
    candidates: Array.isArray(r.candidates) ? (r.candidates as string[]) : [],
    walkAttempts: Number(r.walk_attempts ?? 0),
  }));
}

/**
 * Settled rows the current walk has not read: `none` rows with banked
 * results, postcode rows with a stored site and, when asked for, registry
 * rows no page has confirmed. Resumable by the walk marker, in company-number
 * order, sliced by the same bucket as discovery.
 */
export function makeSelectRewalk(sql: Sql, selection: RewalkSelection = {}) {
  const shard = selection.shard ?? WHOLE_SET;
  const settled = settledRows(selection.evidence);
  const rereadBefore = selection.rereadBefore ?? null;
  return async (maxRows: number): Promise<RewalkRow[]> => {
    if (selection.seed) {
      // No marker predicate: a measurement draws from every settled row.
      return toRows(
        await sql`
          SELECT w.company_number, w.evidence, w.source, w.url, w.candidates,
            p.postal_code,
            coalesce(p.company_name, '') AS company_name, p.locality,
            ${sql.unsafe(SPONSOR_NAMES_COLUMN)},
            ${sql.unsafe(SPONSOR_TOWNS_COLUMN)},
            0 AS walk_attempts
          FROM company_websites w
          JOIN companies_house_profiles p USING (company_number)
          WHERE ${sql.unsafe(settled)}
          ORDER BY md5(w.company_number || ${selection.seed}::text), w.company_number
          LIMIT ${maxRows}
        `,
      );
    }
    return toRows(
      await sql`
        SELECT w.company_number, w.evidence, w.source, w.url, w.candidates,
          p.postal_code,
          coalesce(p.company_name, '') AS company_name, p.locality,
          ${sql.unsafe(SPONSOR_NAMES_COLUMN)},
          ${sql.unsafe(SPONSOR_TOWNS_COLUMN)},
          w.walk_attempts
        FROM company_websites w
        JOIN companies_house_profiles p USING (company_number)
        CROSS JOIN (SELECT ${rereadBefore}::timestamp AS cutoff) reread
        WHERE ${sql.unsafe(settled)}
          AND ${sql.unsafe(UNREAD)}
          AND mod(
            ('x' || left(md5(w.company_number), 7))::bit(28)::int,
            ${shard.count}::int
          ) = ${shard.index}::int
        ORDER BY w.company_number
        LIMIT ${maxRows}
      `,
    );
  };
}

/**
 * Write what the re-walk proved, as an upgrade only. A `none` row gains its
 * site; a postcode row gains `crn_on_page` on the site it already holds; a
 * registry row gains its number or its confirmation there. `checked_at` is
 * cleared so the sweep confirms the row before it renders.
 */
export function makeUpgrade(sql: Sql) {
  return async (
    row: RewalkRow,
    outcome: DiscoveryOutcome,
    confidence: number,
  ): Promise<boolean> => {
    if (!outcome.url || outcome.evidence === 'none') return false;
    if (row.evidence === 'registry') {
      // The two rungs above `registry` a page can prove; anything else is not an upgrade.
      if (
        outcome.evidence !== 'crn_on_page' &&
        outcome.evidence !== 'registry_confirmed'
      ) {
        return false;
      }
      const confirmed = await sql`
        UPDATE company_websites SET
          evidence      = ${outcome.evidence},
          evidence_url  = ${outcome.evidenceUrl},
          confidence    = ${confidence.toFixed(3)}::numeric,
          checked_at    = NULL,
          walk_version  = ${CURRENT_WALK_VERSION},
          walk_attempts = 0,
          walked_at     = now()
        WHERE company_number = ${row.companyNumber}
          AND source = ${row.source} AND evidence = 'registry'
          AND url = ${row.url} AND status IN ('verified', 'unreachable')
        RETURNING company_number
      `;
      return confirmed.length > 0;
    }
    const updated =
      row.evidence === 'none'
        ? await sql`
            UPDATE company_websites SET
              url           = ${outcome.url},
              evidence_url  = ${outcome.evidenceUrl},
              status        = 'verified',
              evidence      = ${outcome.evidence},
              confidence    = ${confidence.toFixed(3)}::numeric,
              checked_at    = NULL,
              failure_count = 0,
              walk_version  = ${CURRENT_WALK_VERSION},
              walk_attempts = 0,
              walked_at     = now()
            WHERE company_number = ${row.companyNumber}
              AND source = 'search' AND evidence = 'none' AND url IS NULL
              AND status = 'none'
            RETURNING company_number
          `
        : await sql`
            UPDATE company_websites SET
              evidence      = 'crn_on_page',
              evidence_url  = ${outcome.evidenceUrl},
              confidence    = ${confidence.toFixed(3)}::numeric,
              checked_at    = NULL,
              walk_version  = ${CURRENT_WALK_VERSION},
              walk_attempts = 0,
              walked_at     = now()
            WHERE company_number = ${row.companyNumber}
              AND source = 'search' AND evidence = 'postcode_on_page'
              AND url = ${row.url} AND status IN ('verified', 'unreachable')
            RETURNING company_number
          `;
    return updated.length > 0;
  };
}

/** Stamp a row the current walk read and could not improve. */
export function makeMarkWalked(sql: Sql) {
  return async (row: RewalkRow): Promise<void> => {
    await sql`
      UPDATE company_websites SET
        walk_version  = ${CURRENT_WALK_VERSION},
        walk_attempts = 0,
        walked_at     = now()
      WHERE company_number = ${row.companyNumber} AND source = ${row.source}
        AND evidence = ${row.evidence} AND url IS NOT DISTINCT FROM ${row.url}
    `;
  };
}

/** Count an unreadable re-walk; the last allowed one stamps the row as walked. */
export function makeMarkUnreadable(sql: Sql) {
  return async (row: RewalkRow): Promise<void> => {
    await sql`
      UPDATE company_websites SET
        walk_version = CASE WHEN walk_attempts + 1 >= ${MAX_WALK_ATTEMPTS}
          THEN ${CURRENT_WALK_VERSION} ELSE walk_version END,
        walked_at = CASE WHEN walk_attempts + 1 >= ${MAX_WALK_ATTEMPTS}
          THEN now() ELSE walked_at END,
        walk_attempts = CASE WHEN walk_attempts + 1 >= ${MAX_WALK_ATTEMPTS}
          THEN 0 ELSE walk_attempts + 1 END
      WHERE company_number = ${row.companyNumber} AND source = ${row.source}
        AND evidence = ${row.evidence} AND url IS NOT DISTINCT FROM ${row.url}
    `;
  };
}

/** Record the statutory numbers a site's pages stated, refreshing ones seen before. */
export function makeRecordStated(sql: Sql) {
  return async (entries: readonly StatedOnSite[]): Promise<void> => {
    const rows = dedupeStated(entries);
    if (rows.length === 0) return;
    await sql`
      INSERT INTO website_stated_numbers (host, company_number, page_url, context)
      SELECT * FROM unnest(
        ${rows.map((r) => r.host)}::text[],
        ${rows.map((r) => r.companyNumber)}::text[],
        ${rows.map((r) => r.pageUrl)}::text[],
        ${rows.map((r) => r.context)}::text[]
      )
      ON CONFLICT (host, company_number) DO UPDATE SET
        page_url     = excluded.page_url,
        context      = excluded.context,
        last_seen_at = now()
    `;
  };
}

/** Settled rows a run with this selection has still to read, by kind, for the run summary. */
export function makeRewalkRemaining(
  sql: Sql,
  selection: Pick<RewalkSelection, 'evidence' | 'rereadBefore'> = {},
) {
  const settled = settledRows(selection.evidence);
  const rereadBefore = selection.rereadBefore ?? null;
  return async (): Promise<{
    none: number;
    postcode: number;
    registry: number;
  }> => {
    const [r] = await sql`
      SELECT
        count(*) FILTER (WHERE w.evidence = 'none')::int AS none,
        count(*) FILTER (WHERE w.evidence = 'postcode_on_page')::int AS postcode,
        count(*) FILTER (WHERE w.evidence = 'registry')::int AS registry
      FROM company_websites w
      CROSS JOIN (SELECT ${rereadBefore}::timestamp AS cutoff) reread
      -- The selector joins the profile, so only rows it can return count.
      WHERE EXISTS (SELECT 1 FROM companies_house_profiles p
          WHERE p.company_number = w.company_number)
        AND ${sql.unsafe(UNREAD)}
        AND ${sql.unsafe(settled)}
    `;
    return {
      none: Number(r.none ?? 0),
      postcode: Number(r.postcode ?? 0),
      registry: Number(r.registry ?? 0),
    };
  };
}
