/**
 * Database wiring for rejecting a site. Each write is guarded on the row still
 * holding what was read, so a row another job changed meanwhile is left alone.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import { rejectSite } from './rejected-site';

type Sql = NeonQueryFunction<false, false>;

/** What rejecting a site did to one row. */
export type RejectOutcome =
  | 'reset'
  | 'stripped'
  | 'unchanged'
  | 'missing'
  | 'moved';

/** A candidates value as the write and its guard bind it: SQL NULL for none. */
function asJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Reject a site on one row: back to `none` if it holds it, and out of its banked candidates. */
export function makeRejectSite(sql: Sql) {
  return async (
    companyNumber: string,
    rejectedUrl: string,
  ): Promise<RejectOutcome> => {
    const [row] = (await sql`
      SELECT url, evidence, candidates FROM company_websites
      WHERE company_number = ${companyNumber}
    `) as { url: string | null; evidence: string; candidates: unknown }[];
    if (!row) return 'missing';
    const change = rejectSite(row, rejectedUrl);
    if (!change) return 'unchanged';
    const candidates = asJson(change.candidates);
    const read = asJson(row.candidates);
    // The walk marker stays: the row was read, and the site is gone from all a walk reads.
    const updated = change.reset
      ? await sql`
          UPDATE company_websites SET
            url           = NULL,
            status        = 'none',
            evidence      = 'none',
            evidence_url  = NULL,
            confidence    = NULL,
            checked_at    = NULL,
            verified_at   = NULL,
            failure_count = 0,
            walk_attempts = 0,
            candidates    = ${candidates}::jsonb
          WHERE company_number = ${companyNumber}
            AND url = ${row.url} AND evidence = ${row.evidence}
            AND candidates IS NOT DISTINCT FROM ${read}::jsonb
          RETURNING company_number
        `
      : await sql`
          UPDATE company_websites SET candidates = ${candidates}::jsonb
          WHERE company_number = ${companyNumber}
            AND url IS NOT DISTINCT FROM ${row.url} AND evidence = ${row.evidence}
            AND candidates IS NOT DISTINCT FROM ${read}::jsonb
          RETURNING company_number
        `;
    if (updated.length === 0) return 'moved';
    return change.reset ? 'reset' : 'stripped';
  };
}
