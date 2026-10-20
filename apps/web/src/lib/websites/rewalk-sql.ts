/**
 * Database wiring for the re-walk. Every write is guarded on the row still
 * holding what the re-walk read, so a row another job changed meanwhile is
 * left alone, and nothing here can lower a row's evidence.
 */

import type { DiscoveryOutcome } from './discover';
import {
  CURRENT_WALK_VERSION,
  MAX_WALK_ATTEMPTS,
  type RewalkRow,
} from './rewalk';
import { type Shard, WHOLE_SET } from './shard';
import { dedupeStated, type StatedOnSite } from './stated-numbers';

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

/** Which settled rows to re-walk. */
export type RewalkSelection = {
  shard?: Shard;
  /** Restrict to one kind of row. */
  evidence?: 'none' | 'postcode_on_page';
  /** A seeded random sample instead of the resumable order; for dry-run measurement only. */
  seed?: string;
};

/** Rows from the database, typed. */
function toRows(rows: Record<string, unknown>[]): RewalkRow[] {
  return rows.map((r) => ({
    companyNumber: r.company_number as string,
    postcode: (r.postal_code as string | null) ?? null,
    evidence: r.evidence as RewalkRow['evidence'],
    url: (r.url as string | null) ?? null,
    candidates: Array.isArray(r.candidates) ? (r.candidates as string[]) : [],
  }));
}

/**
 * Settled search rows the current walk has not read: `none` rows with banked
 * results, and postcode rows with a stored site. Resumable by the walk
 * marker, in company-number order, sliced by the same bucket as discovery.
 */
export function makeSelectRewalk(sql: Sql, selection: RewalkSelection = {}) {
  const shard = selection.shard ?? WHOLE_SET;
  const evidence = selection.evidence ?? null;
  return async (maxRows: number): Promise<RewalkRow[]> => {
    if (selection.seed) {
      // No marker predicate: a measurement draws from every settled row.
      return toRows(
        await sql`
          SELECT w.company_number, w.evidence, w.url, w.candidates, p.postal_code
          FROM company_websites w
          JOIN companies_house_profiles p USING (company_number)
          WHERE w.source = 'search'
            AND (
              (w.evidence = 'none' AND w.status = 'none'
                AND jsonb_typeof(w.candidates) = 'array'
                AND ${evidence}::text IS DISTINCT FROM 'postcode_on_page')
              OR (w.evidence = 'postcode_on_page'
                AND w.status IN ('verified', 'unreachable') AND w.url IS NOT NULL
                AND ${evidence}::text IS DISTINCT FROM 'none')
            )
          ORDER BY md5(w.company_number || ${selection.seed}::text), w.company_number
          LIMIT ${maxRows}
        `,
      );
    }
    return toRows(
      await sql`
        SELECT w.company_number, w.evidence, w.url, w.candidates, p.postal_code
        FROM company_websites w
        JOIN companies_house_profiles p USING (company_number)
        WHERE w.source = 'search'
          AND (
            (w.evidence = 'none' AND w.status = 'none'
              AND jsonb_typeof(w.candidates) = 'array'
              AND ${evidence}::text IS DISTINCT FROM 'postcode_on_page')
            OR (w.evidence = 'postcode_on_page'
              AND w.status IN ('verified', 'unreachable') AND w.url IS NOT NULL
              AND ${evidence}::text IS DISTINCT FROM 'none')
          )
          AND (w.walk_version IS NULL OR w.walk_version < ${CURRENT_WALK_VERSION})
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
 * site; a postcode row gains `crn_on_page` on the site it already holds.
 * `checked_at` is cleared so the sweep confirms the row before it renders.
 */
export function makeUpgrade(sql: Sql) {
  return async (
    row: RewalkRow,
    outcome: DiscoveryOutcome,
    confidence: number,
  ): Promise<boolean> => {
    if (!outcome.url || outcome.evidence === 'none') return false;
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
              AND url = ${row.url}
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
      WHERE company_number = ${row.companyNumber} AND source = 'search'
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
      WHERE company_number = ${row.companyNumber} AND source = 'search'
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

/** Settled rows the current walk has still to read, by kind, for the run summary. */
export function makeRewalkRemaining(sql: Sql) {
  return async (): Promise<{ none: number; postcode: number }> => {
    const [r] = await sql`
      SELECT
        count(*) FILTER (WHERE evidence = 'none')::int AS none,
        count(*) FILTER (WHERE evidence = 'postcode_on_page')::int AS postcode
      FROM company_websites
      WHERE source = 'search'
        AND (walk_version IS NULL OR walk_version < ${CURRENT_WALK_VERSION})
        AND (
          (evidence = 'none' AND status = 'none' AND jsonb_typeof(candidates) = 'array')
          OR (evidence = 'postcode_on_page'
            AND status IN ('verified', 'unreachable') AND url IS NOT NULL)
        )
    `;
    return { none: Number(r.none), postcode: Number(r.postcode) };
  };
}
