/**
 * Database wiring for the registry importer: the rows it decides against and
 * the one write it makes. A row's check and walk state describe its address,
 * so they go when the address does.
 */

import type { createClient, NeonQueryFunction } from '@ss/db/client';
import { companyWebsites } from '@ss/db/schema';
import { type SQL, sql as raw } from 'drizzle-orm';

import type { ExistingWebsite } from './decide';
import { upgradeOnlyPredicateSql } from './decide';
import type { RegistryWrite } from './registry-import';
import { URL_BOUND, type UrlBoundColumn } from './url-bound';

type Sql = NeonQueryFunction<false, false>;

type Db = Pick<ReturnType<typeof createClient>, 'insert'>;

/** Company numbers asked for in one query. */
const READ_CHUNK = 5000;

/** Read the stored rows a run's findings are decided against, by company number, each with whether the owner pinned its address. */
export function makeReadStored(sql: Sql) {
  return async (
    companyNumbers: readonly string[],
  ): Promise<Map<string, ExistingWebsite>> => {
    const stored = new Map<string, ExistingWebsite>();
    for (let i = 0; i < companyNumbers.length; i += READ_CHUNK) {
      const rows = await sql`
        SELECT company_number, url, status, evidence, source,
          url_pinned_at IS NOT NULL AS pinned
        FROM company_websites
        WHERE company_number = ANY(${companyNumbers.slice(i, i + READ_CHUNK)}::text[])
      `;
      for (const r of rows) {
        stored.set(r.company_number as string, {
          url: (r.url as string | null) ?? null,
          status: r.status as ExistingWebsite['status'],
          evidence: r.evidence as ExistingWebsite['evidence'],
          source: (r.source as string | null) ?? null,
          pinned: r.pinned === true,
        });
      }
    }
    return stored;
  };
}

/** A column that describes the stored address: reset when the write changes the address, kept when it does not. Constant SQL text. */
function resetWithUrl(column: UrlBoundColumn): SQL {
  return raw.raw(
    `CASE WHEN company_websites.url IS DISTINCT FROM excluded.url THEN ${URL_BOUND[column]} ELSE company_websites.${column} END`,
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
          checkedAt: resetWithUrl('checked_at'),
          failureCount: resetWithUrl('failure_count'),
          evidenceUrl: resetWithUrl('evidence_url'),
          // The walk marker: a new address has not been walked.
          walkVersion: resetWithUrl('walk_version'),
          walkAttempts: resetWithUrl('walk_attempts'),
          walkedAt: resetWithUrl('walked_at'),
        },
        // The ladder and the pin as decide.ts emits them, so a concurrent writer is not clobbered between the read and this write.
        setWhere: raw.raw(upgradeOnlyPredicateSql()),
      })
      .returning({ companyNumber: companyWebsites.companyNumber });
    return applied.length;
  };
}
