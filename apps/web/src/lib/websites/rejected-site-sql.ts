/**
 * Database wiring for rejecting a site. Every outcome holds only for the whole
 * row still hashing as it did when it was backed up, so a row another job
 * changed since, in any column, is left alone and reported as moved.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import { rejectSite } from './rejected-site';

type Sql = NeonQueryFunction<false, false>;

/** The row a rejection is decided on, as it was backed up. */
export type RowSnapshot = {
  companyNumber: string;
  url: string | null;
  candidates: unknown;
  /** `md5(row::text)` when it was backed up. */
  rowHash: string;
};

/** A listed row: exactly as stored, for the backup, and what a rejection is decided on. */
export type ListedRow = {
  stored: Record<string, unknown>;
  source: string;
  snapshot: RowSnapshot;
};

/** What rejecting a site did to one row. */
export type RejectOutcome = 'reset' | 'stripped' | 'unchanged' | 'moved';

/** Read the listed rows as stored now, each with the hash its rejection is guarded on. */
export function makeReadListed(sql: Sql) {
  return async (companyNumbers: readonly string[]): Promise<ListedRow[]> => {
    // to_jsonb keeps each column as stored: a timestamp to the microsecond, in no time zone.
    const rows = await sql`
      SELECT to_jsonb(w) AS stored, md5(w::text) AS row_hash
      FROM company_websites w
      WHERE w.company_number = ANY(${companyNumbers}::text[])
    `;
    return rows.map((r) => {
      const stored = r.stored as Record<string, unknown>;
      return {
        stored,
        source: stored.source as string,
        snapshot: {
          companyNumber: stored.company_number as string,
          url: (stored.url as string | null) ?? null,
          candidates: stored.candidates,
          rowHash: r.row_hash as string,
        },
      };
    });
  };
}

/** A candidates value as the write binds it: SQL NULL for none. */
function asJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Reject a site on one row, from its backed-up snapshot: back to `none` if it holds it, and out of its banked candidates. */
export function makeRejectSite(sql: Sql) {
  return async (
    row: RowSnapshot,
    rejectedUrl: string,
  ): Promise<RejectOutcome> => {
    const change = rejectSite(row, rejectedUrl);
    // A row clean as backed up is confirmed as one: the site may have arrived since.
    if (!change) {
      const same = await sql`
        SELECT company_number FROM company_websites
        WHERE company_number = ${row.companyNumber}
          AND md5(company_websites::text) = ${row.rowHash}
      `;
      return same.length === 0 ? 'moved' : 'unchanged';
    }
    const candidates = asJson(change.candidates);
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
          WHERE company_number = ${row.companyNumber}
            AND md5(company_websites::text) = ${row.rowHash}
          RETURNING company_number
        `
      : await sql`
          UPDATE company_websites SET candidates = ${candidates}::jsonb
          WHERE company_number = ${row.companyNumber}
            AND md5(company_websites::text) = ${row.rowHash}
          RETURNING company_number
        `;
    if (updated.length === 0) return 'moved';
    return change.reset ? 'reset' : 'stripped';
  };
}
