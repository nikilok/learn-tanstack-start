/**
 * Phase 5 sweep CLI — thin wiring layer on top of the orchestration in
 * `apps/web/src/lib/phase5/`. Pulls a tier slice of `hmrc_company_mapping`,
 * re-runs `resolveOneSponsor` per row, and applies the upgrade-only sweep
 * policy (atomic UPDATE + audit CTE; conditional profile UPSERT for
 * `no_match` → `verified` flips; review-queue rows for ambiguous cases).
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/phase5-sweep.ts --tier=no_match
 *   bun apps/web/scripts/phase5-sweep.ts --tier=exact --max-rows=500
 *   bun apps/web/scripts/phase5-sweep.ts --tier=non_exact --dry-run
 *
 * Env (loaded from monorepo root `.env.local` + `apps/web/.env.local`):
 *   POSTGRES_URL                    — required, Neon connection string
 *   COMPANIES_HOUSE_SEED_API_KEY    — CH API key (shared with the seed/Phase 0b)
 *
 * See docs/phase5-sweep-algorithm.md for the per-row decision flow and
 * docs/hmrc-ch-mapping-fix.md "Phase 5" for the design rationale.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@ss/db/client';
import { companiesHouseProfiles } from '@ss/db/schema';
import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/neon-http';
import { resolveOneSponsor } from '../src/lib/hmrc-ch/resolve-sponsor.ts';
import type {
  ApplyPromotionDeps,
  CHFullProfile,
} from '../src/lib/phase5/apply-promotion.ts';
import { applyPromotion } from '../src/lib/phase5/apply-promotion.ts';
import {
  makeBumpVerifiedAt,
  makeCommitPromotion,
  makeEnqueueReview,
  makeLookupLocality,
  makeResolveSponsor,
  makeSelectRows,
  makeSleep,
} from '../src/lib/phase5/sql.ts';
import type {
  SweepConfig,
  SweepDeps,
  SweepSummary,
  Tier,
} from '../src/lib/phase5/sweep.ts';
import { sweep } from '../src/lib/phase5/sweep.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Env loading — POSTGRES_URL at monorepo root, CH API key at apps/web level
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
const tierArg = args.find((a) => a.startsWith('--tier='));
const maxRowsArg = args.find((a) => a.startsWith('--max-rows='));
const DRY_RUN = args.includes('--dry-run');

const VALID_TIERS: readonly Tier[] = [
  'no_match',
  'non_exact',
  'exact',
  'public_body',
];

const TIER_DEFAULT_MAX_ROWS: Record<Tier, number> = {
  no_match: 4000,
  non_exact: 3000,
  exact: 1500,
  public_body: 500,
};

if (!tierArg) {
  throw new Error(
    `Missing --tier=<name>. Valid tiers: ${VALID_TIERS.join(', ')}`,
  );
}

const tier = tierArg.replace('--tier=', '') as Tier;
if (!VALID_TIERS.includes(tier)) {
  throw new Error(
    `Invalid tier "${tier}". Valid tiers: ${VALID_TIERS.join(', ')}`,
  );
}

const maxRows = maxRowsArg
  ? Number.parseInt(maxRowsArg.replace('--max-rows=', ''), 10)
  : TIER_DEFAULT_MAX_ROWS[tier];

if (!Number.isFinite(maxRows) || maxRows <= 0) {
  throw new Error(`Invalid --max-rows value (must be positive integer)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DB host descriptor — extracts only the hostname from POSTGRES_URL so the
// startup banner can show which Neon branch we're connected to without
// leaking credentials. Never include user, password, or query params.
// ─────────────────────────────────────────────────────────────────────────────

function describeDbHost(url: string | undefined): string {
  if (!url) return '(not set)';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CH API client (rate-limit aware)
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.company-information.service.gov.uk';
const AUTH_HEADER = `Basic ${Buffer.from(`${CH_API_KEY}:`).toString('base64')}`;

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Retry budget for 429 backoffs. With 3 retries × 60s, a single request can
 *  spend up to ~3 minutes recovering before the row is given up on as
 *  errored. Prevents an exhausted CH quota from looping the sweep against
 *  the workflow's 240-minute timeout (CodeRabbit PR #85, comment 1). */
const FETCH_MAX_RETRIES = 3;

async function fetchApi(
  path: string,
  retriesLeft = FETCH_MAX_RETRIES,
): Promise<unknown | null> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: AUTH_HEADER },
  });
  if (res.status === 429) {
    if (retriesLeft <= 0) {
      console.error(`  Rate limit retries exhausted for ${path}, giving up`);
      return null;
    }
    console.log(
      `  Rate limited, backing off for 60s… (${retriesLeft} retries left)`,
    );
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
  if (!res.ok) return null;
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile UPSERT — mirrors the helper in apps/web/src/api/companiesHouse.ts
// (kept inline so the script does not pull in the TanStack Start runtime).
// ─────────────────────────────────────────────────────────────────────────────

const sql = neon(process.env.POSTGRES_URL);
const db = drizzle({ client: sql });

async function upsertProfile(profile: CHFullProfile): Promise<void> {
  const row = profileToDbRow(profile);
  await db.insert(companiesHouseProfiles).values(row).onConflictDoUpdate({
    target: companiesHouseProfiles.companyNumber,
    set: row,
  });
}

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
    previousCompanyNames: previousNames.map((p) => p.name),
    confirmationStatementLastMadeUpTo: confirmation.last_made_up_to ?? null,
    updatedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire up the deps
// ─────────────────────────────────────────────────────────────────────────────

const applyDeps: ApplyPromotionDeps = {
  commitPromotion: makeCommitPromotion(sql),
  upsertProfile,
};

const dryRunNoOp = async () => {};

const sweepDeps: SweepDeps = {
  selectRows: makeSelectRows(sql),
  lookupLocality: makeLookupLocality(sql),
  resolveSponsor: makeResolveSponsor((orgName, locality) =>
    resolveOneSponsor(orgName, locality, fetchApi),
  ),
  applyPromotion: DRY_RUN
    ? async () => ({ ok: true })
    : (existing, proposed, changedBy) =>
        applyPromotion(existing, proposed, changedBy, applyDeps),
  bumpVerifiedAt: DRY_RUN ? dryRunNoOp : makeBumpVerifiedAt(sql),
  enqueueReview: DRY_RUN ? dryRunNoOp : makeEnqueueReview(sql),
  sleep: makeSleep(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const config: SweepConfig = { tier, maxRows };
const startedAt = Date.now();

console.log(
  `Phase 5 sweep — tier=${tier} max_rows=${maxRows}${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`,
);
console.log(`  db host      : ${describeDbHost(process.env.POSTGRES_URL)}`);
console.log('───────────────────────────────────────────────────────────');

const summary: SweepSummary = await sweep(config, sweepDeps);

const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log('');
console.log(`  selected     : ${summary.selected}`);
console.log(`  updated      : ${summary.updated}`);
console.log(`  bumped       : ${summary.bumped}`);
console.log(`  queued       : ${summary.queued}`);
console.log(`  lock_missed  : ${summary.lockMissed}`);
console.log(`  errored      : ${summary.errored}`);
console.log(`  duration     : ${durationSec}s`);
