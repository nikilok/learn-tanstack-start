/**
 * Phase 1 backfill: reconcile the two previous-name columns on
 * companies_house_profiles — previous_company_names (text[], search) and
 * previous_company_names_dated (jsonb, timeline) — from the authoritative
 * Companies House profile, for rows that carry previous names but no dated data
 * yet. Writes BOTH columns from the same CH fetch so they can't diverge; DB-only
 * (nothing reads the dated column until Phase 2, so no cache purge).
 *
 * Self-resuming: targets rows still at the '[]' dated default, and an optimistic
 * guard (WHERE dated = '[]') means a concurrent ch-stream write is never
 * clobbered. Empty CH names clear our stale text[], dropping the row from the
 * predicate (so drift rows converge instead of being re-fetched forever).
 * Idempotent; safe to pause / re-run.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/backfill-previous-names-dated.ts --dry-run --max-rows=20
 *   bun apps/web/scripts/backfill-previous-names-dated.ts --max-rows=5000
 *   bun apps/web/scripts/backfill-previous-names-dated.ts            # full (~32k)
 *
 * Env (root .env.local + apps/web/.env.local):
 *   POSTGRES_URL, COMPANIES_HOUSE_SEED_API_KEY
 */

import { companiesHouseProfiles, toDatedPreviousNames } from '@ss/db';
import { neon } from '@ss/db/client';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

import { delay, fetchApi } from './lib/ch-client.ts';
import {
  ERROR_RATE_THRESHOLD,
  loadScriptEnv,
  parseStrictInt,
} from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);
if (!process.env.COMPANIES_HOUSE_SEED_API_KEY)
  throw new Error('Set COMPANIES_HOUSE_SEED_API_KEY in apps/web/.env.local');

// ── Args (strict; unknown/malformed tokens throw) ──
let DRY_RUN = false;
let MAX_ROWS = Number.POSITIVE_INFINITY;
let DELAY_MS = 600; // CH REST limit is 600 req / 5 min (2/sec); 600ms stays under.
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') DRY_RUN = true;
  else if (arg.startsWith('--max-rows='))
    MAX_ROWS = parseStrictInt(arg.slice(11), '--max-rows');
  else if (arg.startsWith('--delay-ms='))
    DELAY_MS = parseStrictInt(arg.slice(11), '--delay-ms');
  else throw new Error(`Unknown argument "${arg}"`);
}

const sql = neon(process.env.POSTGRES_URL as string);
const db = drizzle({ client: sql });
// Only start evaluating the abort rate once enough rows have run to be meaningful.
const MIN_ROWS_BEFORE_ABORT = 20;

type CHPrev = { name?: string; effective_from?: string; ceased_on?: string }[];

async function main() {
  // Rows with previous names still at the '[]' default → self-resuming target.
  const targets = (await sql`
    SELECT company_number
    FROM companies_house_profiles
    WHERE array_length(previous_company_names, 1) > 0
      AND previous_company_names_dated = '[]'::jsonb
    ORDER BY company_number
  `) as { company_number: string }[];

  const slice = targets.slice(0, MAX_ROWS);
  console.log(
    `Backfill previous-names dates — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`,
  );
  console.log(
    `Unfilled targets: ${targets.length}, processing: ${slice.length}\n`,
  );

  let filled = 0;
  let reconciledEmpty = 0;
  let superseded = 0;
  let gone = 0;
  let errored = 0;

  for (const [i, t] of slice.entries()) {
    const num = t.company_number;
    const label = `[${i + 1}/${slice.length}] ${num}`;

    // Fail fast on a dead key / CH outage instead of burning the whole ~32k run.
    if (i >= MIN_ROWS_BEFORE_ABORT && errored / i > ERROR_RATE_THRESHOLD) {
      console.error(
        `\nAbort: error rate ${((errored / i) * 100).toFixed(1)}% after ${i} rows exceeds ${ERROR_RATE_THRESHOLD * 100}% — stopping early.`,
      );
      process.exitCode = 1;
      break;
    }

    try {
      const outcome = await fetchApi(`/company/${num}`);
      if (!outcome.ok) {
        if (outcome.notFound) {
          gone++;
          console.log(`  ${label} GONE (404/410)`);
        } else {
          errored++;
          console.log(`  ${label} ERROR`);
        }
        await delay(DELAY_MS);
        continue;
      }

      const profile = outcome.data as { previous_company_names?: CHPrev };
      const chNames = (profile.previous_company_names ?? [])
        .map((p) => p?.name)
        .filter((n): n is string => !!n);
      const dated = toDatedPreviousNames(profile.previous_company_names);

      if (!DRY_RUN) {
        // Write both columns from the same CH payload so they can't diverge.
        // Optimistic guard: only if dated is still '[]' — if ch-stream filled it
        // mid-run, skip rather than clobber its fresher value. No updatedAt bump:
        // this reconciliation isn't a new CH event and shouldn't read as one.
        const applied = await db
          .update(companiesHouseProfiles)
          .set({
            previousCompanyNames: chNames,
            previousCompanyNamesDated: dated,
          })
          .where(
            and(
              eq(companiesHouseProfiles.companyNumber, num),
              dsql`${companiesHouseProfiles.previousCompanyNamesDated} = '[]'::jsonb`,
            ),
          )
          .returning({ n: companiesHouseProfiles.companyNumber });
        if (applied.length === 0) {
          superseded++;
          console.log(`  ${label} superseded by ch-stream — skipped`);
          await delay(DELAY_MS);
          continue;
        }
      }

      if (dated.length === 0) {
        reconciledEmpty++;
        console.log(`  ${label} CH has no previous names — text[] cleared`);
      } else {
        filled++;
        console.log(`  ${label} → ${dated.length} dated name(s)`);
      }
    } catch (err) {
      // A single malformed payload / transient DB error must not crash the run.
      errored++;
      console.log(
        `  ${label} ERROR (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    await delay(DELAY_MS);
  }

  console.log(
    `\nSummary: filled=${filled} reconciled-empty=${reconciledEmpty} superseded=${superseded} gone=${gone} errored=${errored}`,
  );
  if (slice.length > 0 && errored / slice.length > ERROR_RATE_THRESHOLD) {
    console.error(
      `\nError rate ${((errored / slice.length) * 100).toFixed(1)}% exceeds ${ERROR_RATE_THRESHOLD * 100}% — treat as FAILED and re-run.`,
    );
    process.exitCode = 1;
  }
}

await main();
