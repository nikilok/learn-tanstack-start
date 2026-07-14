/**
 * Phase 1 backfill: populate companies_house_profiles.previous_company_names_dated
 * from Companies House for rows that carry previous names but no dated data yet
 * (the effective_from/ceased_on dates were discarded at ingest before this
 * feature). DB-only — nothing reads the column until Phase 2, so no cache purge.
 *
 * Self-resuming: it only targets rows still at the '[]' default, so a paused or
 * interrupted run just needs re-running — filled rows are skipped without a
 * fetch. Idempotent.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/backfill-previous-names-dated.ts --dry-run --max-rows=20
 *   bun apps/web/scripts/backfill-previous-names-dated.ts --max-rows=5000
 *   bun apps/web/scripts/backfill-previous-names-dated.ts            # full (~32k)
 *
 * Env (root .env.local + apps/web/.env.local):
 *   POSTGRES_URL, COMPANIES_HOUSE_SEED_API_KEY
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { companiesHouseProfiles, toDatedPreviousNames } from '@ss/db';
import { neon } from '@ss/db/client';
import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

import { delay, fetchApi } from './lib/ch-client.ts';

// ── Env ──────────────────────────────────────────────────────────────────────
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(SCRIPT_DIR, '../../../.env.local');
const APP_ENV = resolve(SCRIPT_DIR, '../.env.local');
dotenv.config({ path: ROOT_ENV });
dotenv.config({ path: APP_ENV });
if (!process.env.POSTGRES_URL)
  throw new Error(`POSTGRES_URL not in ${ROOT_ENV} or ${APP_ENV}`);
if (!process.env.COMPANIES_HOUSE_SEED_API_KEY)
  throw new Error(`Set COMPANIES_HOUSE_SEED_API_KEY in ${APP_ENV}`);

// ── Args (strict; unknown/malformed tokens throw) ──
/** Parse a whole non-negative integer; rejects '', '1e3', '10.5', '100abc'. */
function parseStrictInt(raw: string, label: string): number {
  if (!/^\d+$/.test(raw))
    throw new Error(
      `Invalid ${label}="${raw}" — must be a whole non-negative integer`,
    );
  return Number.parseInt(raw, 10);
}
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

const sql = neon(process.env.POSTGRES_URL);
const db = drizzle({ client: sql });
const ERROR_RATE_THRESHOLD = 0.1;

type CHPrev = { name?: string; effective_from?: string; ceased_on?: string }[];

async function main() {
  // Only rows with previous names still at the '[]' default → self-resuming.
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
  let noPrev = 0;
  let gone = 0;
  let errored = 0;

  for (const [i, t] of slice.entries()) {
    const num = t.company_number;
    const label = `[${i + 1}/${slice.length}] ${num}`;
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
    const dated = toDatedPreviousNames(profile.previous_company_names);
    if (dated.length === 0) {
      // Our text[] had names but CH's authoritative list is empty (drift) — leave '[]'.
      noPrev++;
      console.log(`  ${label} no CH previous names — left '[]'`);
      await delay(DELAY_MS);
      continue;
    }
    console.log(`  ${label} → ${dated.length} dated name(s)`);
    if (!DRY_RUN) {
      // Dated column only; do NOT bump updatedAt — this invisible fill isn't a
      // real profile change and shouldn't read as "updated just now" en masse.
      await db
        .update(companiesHouseProfiles)
        .set({ previousCompanyNamesDated: dated })
        .where(eq(companiesHouseProfiles.companyNumber, num));
    }
    filled++;
    await delay(DELAY_MS);
  }

  console.log(
    `\nSummary: filled=${filled} no-prev=${noPrev} gone=${gone} errored=${errored}`,
  );
  if (slice.length > 0 && errored / slice.length > ERROR_RATE_THRESHOLD) {
    console.error(
      `\nAbort: error rate ${((errored / slice.length) * 100).toFixed(1)}% exceeds ${ERROR_RATE_THRESHOLD * 100}% — treat as FAILED and re-run.`,
    );
    process.exitCode = 1;
  }
}

await main();
