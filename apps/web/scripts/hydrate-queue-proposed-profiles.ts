/**
 * Step A of the one-shot review-queue drain. Fetches CH profiles for every
 * `proposed_company_number` referenced by an unresolved queue row that isn't
 * already in `companies_house_profiles`, and UPSERTs them. After this script
 * runs, the drain script in step B/C can decide every queue row from local
 * data with zero CH calls.
 *
 * Idempotent — re-runs are no-ops because the LEFT JOIN already excludes
 * cached rows. Profiles that 404 are logged and skipped; the corresponding
 * queue rows surface as `orphan` in the step-B comparison report.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/hydrate-queue-proposed-profiles.ts --dry-run
 *   bun apps/web/scripts/hydrate-queue-proposed-profiles.ts
 *   bun apps/web/scripts/hydrate-queue-proposed-profiles.ts --limit=20
 *
 * Env (loaded from monorepo root `.env.local` + `apps/web/.env.local`):
 *   POSTGRES_URL                    — required, Neon connection string
 *   COMPANIES_HOUSE_SEED_API_KEY    — CH API key
 *
 * Delete this script after `hmrc_company_mapping_review_queue` is dropped.
 *
 * See docs/phase5-sweep-algorithm.md §"Step A — hydrate missing proposed
 * profiles".
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { neon } from '@ss/db/client';
import { companiesHouseProfiles, toDatedPreviousNames } from '@ss/db/schema';
import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/neon-http';

import type { CHFullProfile } from '../src/lib/phase5/apply-promotion.ts';
import { dbFingerprint } from '../src/lib/phase5/db-host.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Env loading
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(SCRIPT_DIR, '../../../.env.local');
const APP_ENV = resolve(SCRIPT_DIR, '../.env.local');
dotenv.config({ path: ROOT_ENV });
dotenv.config({ path: APP_ENV });

if (!process.env.POSTGRES_URL) {
  throw new Error(`POSTGRES_URL not in ${ROOT_ENV} or ${APP_ENV}`);
}

const CH_API_KEY = process.env.COMPANIES_HOUSE_SEED_API_KEY;
if (!CH_API_KEY) {
  throw new Error(`Set COMPANIES_HOUSE_SEED_API_KEY in ${APP_ENV}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const DRY_RUN = args.includes('--dry-run');

/** ~2 req/sec — well under CH's 600 / 5 min quota. */
const SLEEP_MS = 550;

/** Strict whole-number parse — same shape as phase5-sweep.ts. */
function parseStrictInt(raw: string, label: string, min: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid ${label}="${raw}" — must be a whole non-negative integer`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (n < min) {
    throw new Error(`Invalid ${label}="${raw}" — must be >= ${min}`);
  }
  return n;
}

const limit = limitArg
  ? parseStrictInt(limitArg.replace('--limit=', ''), '--limit', 1)
  : undefined;

// ─────────────────────────────────────────────────────────────────────────────
// CH API client (rate-limit aware) — mirrors phase5-sweep.ts's fetchApi.
// Kept inline so the script stays self-contained and deletable.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.company-information.service.gov.uk';
const AUTH_HEADER = `Basic ${Buffer.from(`${CH_API_KEY}:`).toString('base64')}`;
const FETCH_MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

type FetchOutcome =
  | { kind: 'ok'; data: unknown }
  | { kind: 'not_found' }
  | { kind: 'error' };

/** Three-way result so the caller can count 404s (orphan candidates) apart
 *  from exhausted retries on 429/5xx/network errors (real failures). */
async function fetchCompanyProfile(
  number: string,
  retriesLeft = FETCH_MAX_RETRIES,
): Promise<FetchOutcome> {
  const path = `/company/${number}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: AUTH_HEADER },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (retriesLeft <= 0) {
      console.error(
        `  Network error/timeout for ${path}, giving up: ${err instanceof Error ? err.message : err}`,
      );
      return { kind: 'error' };
    }
    console.log(
      `  Network error/timeout, backing off 60s (${retriesLeft} retries left)`,
    );
    await delay(60_000);
    return fetchCompanyProfile(number, retriesLeft - 1);
  }
  clearTimeout(timeoutId);

  if (res.status === 404) return { kind: 'not_found' };

  if (res.status === 429) {
    if (retriesLeft <= 0) {
      console.error(`  Rate limit retries exhausted for ${path}, giving up`);
      return { kind: 'error' };
    }
    console.log(
      `  Rate limited, backing off 60s (${retriesLeft} retries left)`,
    );
    await delay(60_000);
    return fetchCompanyProfile(number, retriesLeft - 1);
  }
  if (res.status >= 500 && res.status < 600) {
    if (retriesLeft <= 0) {
      console.error(
        `  Server error ${res.status} retries exhausted for ${path}, giving up`,
      );
      return { kind: 'error' };
    }
    console.log(
      `  Server error ${res.status}, backing off 60s (${retriesLeft} retries left)`,
    );
    await delay(60_000);
    return fetchCompanyProfile(number, retriesLeft - 1);
  }
  // Auth failures (401/403) are non-retryable with the same credentials —
  // fail fast rather than burn the rest of the work and only trip on the
  // tail-end error-rate threshold.
  if (res.status === 401 || res.status === 403) {
    throw new Error(`CH authentication failed with ${res.status} for ${path}`);
  }
  if (!res.ok) {
    console.error(`  Unexpected status ${res.status} for ${path}`);
    return { kind: 'error' };
  }
  return { kind: 'ok', data: await res.json() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile UPSERT — mirrors phase5-sweep.ts's helper, kept inline.
// ─────────────────────────────────────────────────────────────────────────────

const sql = neon(process.env.POSTGRES_URL);
const db = drizzle({ client: sql });

type CHRegisteredAddress = {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

type CHAccounts = {
  next_made_up_to?: string;
  last_accounts?: { made_up_to?: string };
  overdue?: boolean;
};

function profileToDbRow(profile: CHFullProfile) {
  const address = (profile.registered_office_address ??
    {}) as CHRegisteredAddress;
  const accounts = (profile.accounts ?? {}) as CHAccounts;
  const previousNames = (profile.previous_company_names ?? []) as {
    name: string;
    effective_from?: string;
    ceased_on?: string;
  }[];
  const confirmation = (profile.confirmation_statement ?? {}) as {
    last_made_up_to?: string;
  };

  return {
    companyNumber: profile.company_number,
    companyName: profile.company_name,
    companyStatus: profile.company_status ?? null,
    companyType: (profile.type as string | undefined) ?? null,
    dateOfCreation: (profile.date_of_creation as string | undefined) ?? null,
    addressLine1: address.address_line_1 ?? null,
    addressLine2: address.address_line_2 ?? null,
    locality: address.locality ?? null,
    region: address.region ?? null,
    postalCode: address.postal_code ?? null,
    country: address.country ?? null,
    sicCodes: (profile.sic_codes as string[] | undefined) ?? [],
    accountsNextMadeUpTo: accounts.next_made_up_to ?? null,
    accountsLastMadeUpTo: accounts.last_accounts?.made_up_to ?? null,
    accountsOverdue: accounts.overdue ?? null,
    jurisdiction: (profile.jurisdiction as string | undefined) ?? null,
    hasBeenLiquidated:
      (profile.has_been_liquidated as boolean | undefined) ?? null,
    hasInsolvencyHistory:
      (profile.has_insolvency_history as boolean | undefined) ?? null,
    hasCharges: (profile.has_charges as boolean | undefined) ?? null,
    previousCompanyNames: previousNames.map((p) => p.name).filter((n) => !!n),
    previousCompanyNamesDated: toDatedPreviousNames(previousNames),
    confirmationStatementLastMadeUpTo: confirmation.last_made_up_to ?? null,
    updatedAt: new Date(),
  };
}

async function upsertProfile(profile: CHFullProfile): Promise<void> {
  const row = profileToDbRow(profile);
  await db.insert(companiesHouseProfiles).values(row).onConflictDoUpdate({
    target: companiesHouseProfiles.companyNumber,
    set: row,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log(
  `Hydrate queue proposed profiles${DRY_RUN ? ' (DRY RUN — no fetches, no writes)' : ''}${limit !== undefined ? ` limit=${limit}` : ''}`,
);
console.log(`  db host      : ${dbFingerprint(process.env.POSTGRES_URL)}`);
console.log('───────────────────────────────────────────────────────────');

type ToFetchRow = { proposed_company_number: string };
const allMissing = (await sql`
  SELECT DISTINCT q.proposed_company_number
    FROM hmrc_company_mapping_review_queue q
    LEFT JOIN companies_house_profiles p
           ON p.company_number = q.proposed_company_number
   WHERE q.resolved_at IS NULL
     AND q.proposed_company_number IS NOT NULL
     AND p.company_number IS NULL
   ORDER BY q.proposed_company_number
`) as ToFetchRow[];

const toFetch = limit !== undefined ? allMissing.slice(0, limit) : allMissing;

console.log(`  missing      : ${allMissing.length}`);
if (limit !== undefined) console.log(`  to fetch     : ${toFetch.length}`);

if (toFetch.length === 0) {
  console.log(
    '  nothing to do — every queue row already has its profile cached.',
  );
  process.exit(0);
}

if (DRY_RUN) {
  for (const row of toFetch.slice(0, 10)) {
    console.log(`    ${row.proposed_company_number}`);
  }
  if (toFetch.length > 10) {
    console.log(`    … (${toFetch.length - 10} more)`);
  }
  console.log('');
  console.log('  DRY RUN — exiting before fetches.');
  process.exit(0);
}

let hydrated = 0;
let notFound = 0;
let errored = 0;
const startedAt = Date.now();

for (let i = 0; i < toFetch.length; i++) {
  const num = toFetch[i].proposed_company_number;
  const idx = `[${i + 1}/${toFetch.length}]`;

  const outcome = await fetchCompanyProfile(num);

  if (outcome.kind === 'not_found') {
    notFound += 1;
    console.log(`  ${idx} ${num} → 404 (orphan candidate)`);
  } else if (outcome.kind === 'error') {
    errored += 1;
    console.log(`  ${idx} ${num} → error (see logs above)`);
  } else {
    await upsertProfile(outcome.data as CHFullProfile);
    hydrated += 1;
    if ((i + 1) % 20 === 0 || i + 1 === toFetch.length) {
      console.log(
        `  ${idx} ${num} → cached (${hydrated} hydrated, ${notFound} 404, ${errored} errored)`,
      );
    }
  }

  if (i < toFetch.length - 1) await delay(SLEEP_MS);
}

const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log('');
console.log(`  hydrated     : ${hydrated}`);
console.log(`  not found    : ${notFound}`);
console.log(`  errored      : ${errored}`);
console.log(`  duration     : ${durationSec}s`);

const ERROR_RATE_THRESHOLD = 0.1;
const errorRate = errored / toFetch.length;
if (errorRate > ERROR_RATE_THRESHOLD) {
  console.error('');
  console.error(
    `  ERROR RATE ${(errorRate * 100).toFixed(1)}% exceeds ${ERROR_RATE_THRESHOLD * 100}% threshold.`,
  );
  console.error(
    '  Likely a sustained CH outage, rate-limit exhaustion, or auth failure.',
  );
  process.exit(1);
}
