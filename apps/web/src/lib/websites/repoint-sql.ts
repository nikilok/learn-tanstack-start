/**
 * Database wiring for an owner's repoint. Each write holds only for the whole
 * row still hashing as it did when it was backed up, so a row another job
 * changed since, in any column, is left alone and reported as changed.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import type { Repoint } from './repoint';
import { URL_BOUND, type UrlBoundColumn } from './url-bound';

type Sql = NeonQueryFunction<false, false>;

/** The row a repoint is written to, as it was backed up. */
export type RepointSnapshot = {
  companyNumber: string;
  /** `md5(row::text)` when it was backed up. */
  rowHash: string;
};

/** What a repoint did to one row. */
export type RepointOutcome = 'repointed' | 'pinned' | 'changed';

/** What a moved row forgets of its old address: every column that describes one, but the proof page, which the move sets, and the last check when the owner read the new address. Constant SQL text. */
function forgotten(keepLive: boolean): string {
  const kept: UrlBoundColumn[] = keepLive
    ? ['evidence_url', 'checked_at']
    : ['evidence_url'];
  return Object.entries(URL_BOUND)
    .filter(([column]) => !kept.includes(column as UrlBoundColumn))
    .map(([column, reset]) => `${column} = ${reset}`)
    .join(', ');
}

/** Write one repoint from the row's backed-up snapshot: a move to the new address, pinned there, or the pin alone. */
export function makeRepoint(sql: Sql) {
  return async (
    row: RepointSnapshot,
    change: Repoint,
  ): Promise<RepointOutcome> => {
    const updated =
      change.kind === 'pin'
        ? await sql`
            UPDATE company_websites SET url_pinned_at = now()
            WHERE company_number = ${row.companyNumber}
              AND md5(company_websites::text) = ${row.rowHash}
            RETURNING company_number
          `
        : await sql`
            UPDATE company_websites SET
              url           = ${change.url},
              evidence_url  = ${change.evidenceUrl},
              status        = ${change.status},
              url_pinned_at = now(),
              ${sql.unsafe(forgotten(change.keepLive))}
            WHERE company_number = ${row.companyNumber}
              AND md5(company_websites::text) = ${row.rowHash}
            RETURNING company_number
          `;
    if (updated.length === 0) return 'changed';
    return change.kind === 'pin' ? 'pinned' : 'repointed';
  };
}
