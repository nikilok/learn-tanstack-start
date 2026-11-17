/**
 * Database wiring for the registry importer: the one write it makes. A row's
 * check and walk state describe its address, so they go when the address does.
 */

import type { createClient } from '@ss/db/client';
import { companyWebsites } from '@ss/db/schema';
import { type SQL, sql as raw } from 'drizzle-orm';

import { upgradeOnlyPredicateSql } from './decide';
import type { RegistryWrite } from './registry-import';

type Db = Pick<ReturnType<typeof createClient>, 'insert'>;

/** A column that describes the stored address: reset when the write changes the address, kept when it does not. Constant SQL text. */
function resetWithUrl(column: { name: string }, reset: 'NULL' | '0'): SQL {
  return raw.raw(
    `CASE WHEN company_websites.url IS DISTINCT FROM excluded.url THEN ${reset} ELSE company_websites.${column.name} END`,
  );
}

/**
 * Write a batch of register rows, as an upgrade only, and count the rows the
 * guard let through. `checked_at` is never set here: the sweep stamps it once
 * it has fetched the address, and a row cannot render until it has.
 */
export function makeWriteRegistryRows(db: Db) {
  return async (rows: RegistryWrite[]): Promise<number> => {
    if (rows.length === 0) return 0;
    const applied = await db
      .insert(companyWebsites)
      .values(rows)
      .onConflictDoUpdate({
        target: companyWebsites.companyNumber,
        set: {
          url: raw`excluded.url`,
          status: raw`excluded.status`,
          evidence: raw`excluded.evidence`,
          confidence: raw`excluded.confidence`,
          source: raw`excluded.source`,
          verifiedAt: raw`excluded.verified_at`,
          // The sweep's cursor and half the render gate: a new address has not been fetched.
          checkedAt: resetWithUrl(companyWebsites.checkedAt, 'NULL'),
          failureCount: resetWithUrl(companyWebsites.failureCount, '0'),
          evidenceUrl: resetWithUrl(companyWebsites.evidenceUrl, 'NULL'),
          // The walk marker: a new address has not been walked.
          walkVersion: resetWithUrl(companyWebsites.walkVersion, 'NULL'),
          walkAttempts: resetWithUrl(companyWebsites.walkAttempts, '0'),
          walkedAt: resetWithUrl(companyWebsites.walkedAt, 'NULL'),
        },
        // The ladder as decide.ts emits it, so a concurrent writer is not clobbered between the read and this write.
        setWhere: raw.raw(upgradeOnlyPredicateSql()),
      })
      .returning({ companyNumber: companyWebsites.companyNumber });
    return applied.length;
  };
}
