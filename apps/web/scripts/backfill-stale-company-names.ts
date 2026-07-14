/**
 * Backfill stale current company names left behind by the pre-fix ch-stream,
 * which recorded renames into previous_company_names but never advanced
 * companies_house_profiles.company_name (so the current name froze at a now-
 * former name). Re-fetches the authoritative CH profile, reconciles company_name
 * + previous_company_names to CH, then purges the edge-cache tag for each
 * corrected row. Every corrected tag is also appended to a durable recovery file
 * so an interrupted / failed / --no-purge run can replay the purge later with
 * --purge-from (a fixed row drops out of the target predicate, so it can never be
 * re-selected — the file is the only recovery path).
 *
 * The lost new names are recoverable only from CH (they were discarded at
 * ingest), so this re-fetches per company. Idempotent and safe to re-run.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/backfill-stale-company-names.ts --dry-run
 *   bun apps/web/scripts/backfill-stale-company-names.ts --dry-run --max-rows=10
 *   bun apps/web/scripts/backfill-stale-company-names.ts            # fix the 341
 *   bun apps/web/scripts/backfill-stale-company-names.ts --all      # 909 superset
 *   bun apps/web/scripts/backfill-stale-company-names.ts --no-purge # DB only (+ recovery file)
 *   bun apps/web/scripts/backfill-stale-company-names.ts --purge-from=<file>  # replay purges only
 *
 * Env (root .env.local + apps/web/.env.local):
 *   POSTGRES_URL                 — Neon connection string
 *   COMPANIES_HOUSE_SEED_API_KEY — CH REST key (bulk data pulls)
 *   VERCEL_TOKEN, VERCEL_PROJECT_ID — edge-cache purge. VERCEL_TOKEN is the LOCAL
 *     tooling convention (root .env.local); the server runtime uses
 *     VERCEL_API_TOKEN instead. Purge is skipped with --no-purge.
 */

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { neon } from '@ss/db/client';
import { companiesHouseProfiles } from '@ss/db/schema';
import { Vercel } from '@vercel/sdk';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

import { profileToDbRow } from '../src/lib/hmrc-ch/profile-row.ts';
import type { CHFullProfile } from '../src/lib/phase5/apply-promotion.ts';
import { delay, fetchApi } from './lib/ch-client.ts';
import {
  ERROR_RATE_THRESHOLD,
  loadScriptEnv,
  parseStrictInt,
} from './lib/script-utils.ts';

// ── Env ──────────────────────────────────────────────────────────────────────
loadScriptEnv(import.meta.url);
if (!process.env.COMPANIES_HOUSE_SEED_API_KEY)
  throw new Error('Set COMPANIES_HOUSE_SEED_API_KEY in apps/web/.env.local');

// ── Args ───────────────────────────────────────────────────────────────────
// Strict: unknown or malformed tokens throw, so a typo (`--dry-run=true`,
// `--max-rows 10`, `--max-rows=1e3`) can't silently escalate a production run.
let DRY_RUN = false;
let ALL = false;
let NO_PURGE = false;
let MAX_ROWS = Number.POSITIVE_INFINITY;
// CH REST limit is 600 req / 5 min (2/sec); 600ms spacing stays comfortably under.
let DELAY_MS = 600;
let PURGE_FROM: string | undefined;
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') DRY_RUN = true;
  else if (arg === '--all') ALL = true;
  else if (arg === '--no-purge') NO_PURGE = true;
  else if (arg.startsWith('--max-rows='))
    MAX_ROWS = parseStrictInt(arg.slice(11), '--max-rows');
  else if (arg.startsWith('--delay-ms='))
    DELAY_MS = parseStrictInt(arg.slice(11), '--delay-ms');
  else if (arg.startsWith('--purge-from=')) PURGE_FROM = arg.slice(13);
  else throw new Error(`Unknown argument "${arg}"`);
}

const sql = neon(process.env.POSTGRES_URL as string);
const db = drizzle({ client: sql });

// Durable append-log of company-{n} tags whose row was corrected but whose cache
// purge may not have completed — the recovery source for --purge-from.
const PURGE_LOG = resolve(tmpdir(), 'backfill-stale-names-purge-pending.txt');

/** Purge `company-{number}` edge-cache tags via the Vercel SDK (16/req, 5/min). Throws on failure. */
async function purgeTags(tags: string[]): Promise<void> {
  const token = process.env.VERCEL_TOKEN;
  const projectIdOrName = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectIdOrName)
    throw new Error('VERCEL_TOKEN / VERCEL_PROJECT_ID missing — cannot purge');
  const vercel = new Vercel({ bearerToken: token });
  const BATCH = 16;
  const PER_MIN = 5;
  let requests = 0;
  for (let i = 0; i < tags.length; i += BATCH) {
    await vercel.edgeCache.invalidateByTags({
      projectIdOrName,
      requestBody: { tags: tags.slice(i, i + BATCH) },
    });
    requests++;
    if (requests % PER_MIN === 0 && i + BATCH < tags.length) {
      console.log(
        `  [purge] ${requests} batches sent, pausing 60s (rate limit)…`,
      );
      await delay(60_000);
    }
  }
  console.log(
    `[purge] Invalidated ${tags.length} tags in ${requests} batches.`,
  );
}

/** Dedup tags recorded in the recovery file (missing file → empty). */
function readPurgeLog(): string[] {
  if (!existsSync(PURGE_LOG)) return [];
  return [
    ...new Set(
      readFileSync(PURGE_LOG, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/** True when a and b hold the same set of names (order-insensitive). */
function sameNameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** --purge-from: replay a recovery file's tags, then clear it, and exit. */
async function purgeFromFile(file: string) {
  if (!existsSync(file))
    throw new Error(`--purge-from file not found: ${file}`);
  const tags = [
    ...new Set(
      readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  console.log(`Replaying ${tags.length} purge tags from ${file}…`);
  await purgeTags(tags);
  rmSync(file, { force: true });
  console.log('Purge replay complete; recovery file cleared.');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (PURGE_FROM) return purgeFromFile(PURGE_FROM);

  // Two literal queries — neon's tagged template takes values, not SQL fragments.
  const targets = (
    ALL
      ? await sql`
          SELECT p.company_number, p.company_name, p.previous_company_names
          FROM companies_house_profiles p
          WHERE p.company_name = ANY(p.previous_company_names)
          ORDER BY p.company_number`
      : await sql`
          SELECT p.company_number, p.company_name, p.previous_company_names
          FROM companies_house_profiles p
          WHERE p.company_name = ANY(p.previous_company_names)
            AND EXISTS (
              SELECT 1 FROM companies_house_profile_trails t
              WHERE t.company_number = p.company_number
                AND t.column_name = 'previousCompanyNames')
          ORDER BY p.company_number`
  ) as {
    company_number: string;
    company_name: string;
    previous_company_names: string[] | null;
  }[];

  const scope = ALL ? '909 superset (--all)' : '341 confirmed (trail-linked)';
  const slice = targets.slice(0, MAX_ROWS);
  console.log(
    `Backfill stale company names — ${DRY_RUN ? 'DRY RUN' : 'LIVE'} — scope: ${scope}`,
  );
  console.log(`Targets: ${targets.length}, processing: ${slice.length}\n`);

  let fixed = 0;
  let unchanged = 0;
  let reverts = 0;
  let superseded = 0;
  let gone = 0;
  let invalid = 0;
  let errored = 0;

  for (const [i, t] of slice.entries()) {
    const num = t.company_number;
    const label = `[${i + 1}/${slice.length}] ${num}`;
    const outcome = await fetchApi(`/company/${num}`);

    if (!outcome.ok) {
      if (outcome.notFound) {
        gone++;
        console.log(`  ${label} GONE (404/410) — left intact`);
      } else {
        errored++;
        console.log(`  ${label} ERROR — skipped`);
      }
      await delay(DELAY_MS);
      continue;
    }

    const profile = outcome.data as CHFullProfile;
    // Guard a 200 whose body lacks a usable name: profileToDbRow would yield
    // companyName:undefined, which drizzle omits from .set() — leaving the name
    // stale while still bumping updatedAt + purging (a phantom "fix"). Skip it.
    const rawName = (profile as { company_name?: unknown }).company_name;
    if (typeof rawName !== 'string' || rawName.trim() === '') {
      invalid++;
      console.log(`  ${label} INVALID CH payload (no company_name) — skipped`);
      await delay(DELAY_MS);
      continue;
    }

    const row = profileToDbRow(profile);
    const newName = row.companyName;
    // Drop CH blanks: the shared profileToDbRow lacks companiesHouse.ts's
    // filter, and '' satisfies ch_previous_names.name NOT NULL → garbage search.
    const newPrev = row.previousCompanyNames.filter((n) => !!n);
    const storedPrev = t.previous_company_names ?? [];
    const nameChanged = newName !== t.company_name;
    const prevChanged = !sameNameSet(newPrev, storedPrev);
    const nameStillInPrev = newPrev.includes(newName);

    if (nameChanged || prevChanged) {
      const desc = nameChanged
        ? `"${t.company_name}" -> "${newName}"`
        : `prev-list reconciled (name "${newName}" unchanged)`;
      console.log(
        `  ${label}  ${desc}${nameStillInPrev ? '  (genuine revert — CH lists current in prev)' : ''}`,
      );
      if (!DRY_RUN) {
        // Optimistic guard: write only if the name is still the stale value we
        // selected. If the now-live ch-stream advanced it mid-run, this matches
        // 0 rows and we skip, rather than clobbering its newer value.
        const applied = await db
          .update(companiesHouseProfiles)
          .set({
            companyName: newName,
            previousCompanyNames: newPrev,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(companiesHouseProfiles.companyNumber, num),
              eq(companiesHouseProfiles.companyName, t.company_name),
            ),
          )
          .returning({ n: companiesHouseProfiles.companyNumber });
        if (applied.length === 0) {
          superseded++;
          console.log(`  ${label}  superseded by live ch-stream — skipped`);
          await delay(DELAY_MS);
          continue;
        }
        // Durable purge record BEFORE any purge, so a crash/failure is recoverable.
        appendFileSync(PURGE_LOG, `company-${num}\n`);
      }
      fixed++;
    } else {
      unchanged++;
      if (nameStillInPrev) reverts++;
      console.log(
        `  ${label}  unchanged "${t.company_name}"${nameStillInPrev ? '  (genuine revert — CH agrees)' : ''}`,
      );
    }
    await delay(DELAY_MS);
  }

  console.log(
    `\nSummary: fixed=${fixed} unchanged=${unchanged} (genuine-revert=${reverts}) superseded=${superseded} gone=${gone} invalid=${invalid} errored=${errored}`,
  );

  // Loud failure if the run was mostly errors so it can't exit 0 looking green.
  if (slice.length > 0 && errored / slice.length > ERROR_RATE_THRESHOLD) {
    console.error(
      `\nAbort: error rate ${((errored / slice.length) * 100).toFixed(1)}% exceeds ${ERROR_RATE_THRESHOLD * 100}% — treat as FAILED and re-run.`,
    );
    process.exitCode = 1;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — no writes, no purge.');
    return;
  }

  // Purge from the durable log (this run's corrections + any residue from a prior
  // interrupted run), deduped. --no-purge records them for a later --purge-from.
  const pending = readPurgeLog();
  if (NO_PURGE) {
    console.log(
      `--no-purge — ${pending.length} tags recorded in ${PURGE_LOG}; run --purge-from=${PURGE_LOG} to purge.`,
    );
    return;
  }
  if (pending.length > 0) {
    console.log(`\nPurging ${pending.length} edge-cache tags…`);
    try {
      await purgeTags(pending);
      rmSync(PURGE_LOG, { force: true });
    } catch (err) {
      console.error(
        `[purge] FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        `[purge] ${pending.length} tags remain in ${PURGE_LOG}; replay with --purge-from=${PURGE_LOG}`,
      );
      process.exitCode = 1;
    }
  }
}

await main();
