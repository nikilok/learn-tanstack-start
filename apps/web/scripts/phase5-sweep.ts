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

import { profileToDbRow } from '../src/lib/hmrc-ch/profile-row.ts';
import { resolveOneSponsor } from '../src/lib/hmrc-ch/resolve-sponsor.ts';
import type {
  ApplyPromotionDeps,
  CHFullProfile,
} from '../src/lib/phase5/apply-promotion.ts';
import { applyPromotion } from '../src/lib/phase5/apply-promotion.ts';
import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import {
  makeBumpVerifiedAt,
  makeCommitPromotion,
  makeGetProfile,
  makeLookupSponsor,
  makeResolveSponsor,
  makeSelectRows,
  makeSleep,
} from '../src/lib/phase5/sql.ts';
import type {
  ApplyResult,
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

/** Strict whole-number parse. Rejects partial strings like "100abc",
 *  decimals like "100.5", scientific notation like "1e3", and negative
 *  numbers — `Number.parseInt` silently truncates all of those. */
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

const maxRows = maxRowsArg
  ? parseStrictInt(maxRowsArg.replace('--max-rows=', ''), '--max-rows', 1)
  : TIER_DEFAULT_MAX_ROWS[tier];

// Per-row sleep override. Read from PHASE5_DELAY_MS env var (set via repo
// `vars` in the GH Actions workflow) so we can throttle up/down without a
// redeploy. Falls back to the orchestrator's DEFAULT_DELAY_MS (2200) when
// unset.
const delayMsRaw = process.env.PHASE5_DELAY_MS;
const delayMs =
  delayMsRaw !== undefined && delayMsRaw !== ''
    ? parseStrictInt(delayMsRaw, 'PHASE5_DELAY_MS', 0)
    : undefined;

// ─────────────────────────────────────────────────────────────────────────────
// CH API client (rate-limit aware)
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.company-information.service.gov.uk';
const AUTH_HEADER = `Basic ${Buffer.from(`${CH_API_KEY}:`).toString('base64')}`;

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Retry budget for 429 backoffs and network errors. With 3 retries × 60s,
 *  a single request can spend up to ~3 minutes recovering before the row
 *  is given up on as errored. */
const FETCH_MAX_RETRIES = 3;

/** Set by fetchApi whenever a null return means "CH couldn't answer"
 *  (exhausted retries, auth failure) rather than "the resource doesn't
 *  exist" (404). The resolver wrapper consumes it per row: a negative
 *  verdict reached through a transport failure is an outage artifact, not
 *  evidence of absence, and must count as errored — otherwise a sustained
 *  CH outage bumps thousands of rows as healthy no_match re-checks and the
 *  error-rate guard never fires. (Mirrors chFetchFailed in companiesHouse.ts;
 *  safe as module state because the sweep processes rows sequentially.) */
let chTransportFailure = false;

/** Per-request timeout. CH's /search and /company endpoints normally respond
 *  in 200-500ms; anything past 30s is almost certainly a hung connection
 *  (network blip, NAT idle drop, DNS issue) — abort and retry rather than
 *  waste the workflow's 240-min timeout on a single stalled request. */
const FETCH_TIMEOUT_MS = 30_000;

async function fetchApi(
  path: string,
  retriesLeft = FETCH_MAX_RETRIES,
): Promise<unknown | null> {
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
    // AbortError (timeout) and other transient network errors are retryable.
    // Distinguished from CH-side failures (4xx/5xx) which are handled below.
    if (retriesLeft <= 0) {
      console.error(
        `  Network error/timeout for ${path}, giving up: ${err instanceof Error ? err.message : err}`,
      );
      chTransportFailure = true;
      return null;
    }
    console.log(
      `  Network error/timeout, backing off for 60s… (${retriesLeft} retries left)`,
    );
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
  clearTimeout(timeoutId);

  if (res.status === 429) {
    if (retriesLeft <= 0) {
      console.error(`  Rate limit retries exhausted for ${path}, giving up`);
      chTransportFailure = true;
      return null;
    }
    console.log(
      `  Rate limited, backing off for 60s… (${retriesLeft} retries left)`,
    );
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
  // 5xx — transient CH-side outages (502/503/504 during their deploys etc).
  // Same retry shape as 429 but distinct log messages so operators can
  // tell quota-exhaustion apart from server outage.
  if (res.status >= 500 && res.status < 600) {
    if (retriesLeft <= 0) {
      console.error(
        `  Server error ${res.status} retries exhausted for ${path}, giving up`,
      );
      chTransportFailure = true;
      return null;
    }
    console.log(
      `  Server error ${res.status}, backing off for 60s… (${retriesLeft} retries left)`,
    );
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    // 401/403 and other unexpected statuses are systemic, not evidence.
    console.error(`  Unexpected ${res.status} for ${path}`);
    chTransportFailure = true;
    return null;
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile UPSERT — row mapping shared with the bulk snapshot matcher via
// profile-row.ts (kept out of the TanStack Start runtime).
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

// ─────────────────────────────────────────────────────────────────────────────
// Wire up the deps
// ─────────────────────────────────────────────────────────────────────────────

const applyDeps: ApplyPromotionDeps = {
  commitPromotion: makeCommitPromotion(sql),
  upsertProfile,
};

const dryRunOk = async (): Promise<ApplyResult> => ({ ok: true });

const sweepDeps: SweepDeps = {
  selectRows: makeSelectRows(sql),
  lookupSponsor: makeLookupSponsor(sql),
  resolveSponsor: makeResolveSponsor(async (orgName, locality) => {
    chTransportFailure = false;
    const result = await resolveOneSponsor(orgName, locality, fetchApi);
    if (
      chTransportFailure &&
      (result.verdict === 'no_match' || result.verdict === 'human_review')
    ) {
      // Negative verdicts reached through a failed CH call are outage
      // artifacts — throw so the sweep counts the row as errored (and the
      // error-rate guard can see a sustained outage) instead of bumping it
      // as a healthy re-check.
      throw new Error('CH transport failure during resolve');
    }
    return result;
  }),
  getProfile: makeGetProfile(sql),
  applyPromotion: DRY_RUN
    ? dryRunOk
    : (existing, proposed, changedBy) =>
        applyPromotion(existing, proposed, changedBy, applyDeps),
  bumpVerifiedAt: DRY_RUN ? dryRunOk : makeBumpVerifiedAt(sql),
  sleep: makeSleep(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const config: SweepConfig = { tier, maxRows, delayMs };
const startedAt = Date.now();

const delayLabel = delayMs !== undefined ? ` delay=${delayMs}ms` : '';
console.log(
  `Phase 5 sweep — tier=${tier} max_rows=${maxRows}${delayLabel}${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`,
);
console.log(`  db host      : ${dbFingerprint(process.env.POSTGRES_URL)}`);
console.log('───────────────────────────────────────────────────────────');

const summary: SweepSummary = await sweep(config, sweepDeps);

const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log('');
console.log(`  selected            : ${summary.selected}`);
console.log(`  updated             : ${summary.updated}`);
console.log(`  bumped              : ${summary.bumped}`);
console.log(`  inline_resolved     : ${summary.inlineResolved}`);
console.log(`  inline_inconclusive : ${summary.inlineInconclusive}`);
console.log(`  warned              : ${summary.warned}`);
console.log(`  lock_missed         : ${summary.lockMissed}`);
console.log(`  errored             : ${summary.errored}`);
console.log(`  duration            : ${durationSec}s`);

// Fail the workflow run loudly when the error rate is too high — likely a
// sustained CH 429 / outage / auth failure that no auto-retry can recover.
// GitHub Actions sends an email to the workflow owner on failed runs.
const ERROR_RATE_THRESHOLD = 0.1;
const errorRate = summary.selected > 0 ? summary.errored / summary.selected : 0;
if (errorRate > ERROR_RATE_THRESHOLD) {
  console.error('');
  console.error(
    `  ERROR RATE ${(errorRate * 100).toFixed(1)}% exceeds ${ERROR_RATE_THRESHOLD * 100}% threshold.`,
  );
  console.error(
    '  Likely a sustained CH outage, rate-limit exhaustion, or auth failure.',
  );
  console.error('  Check the run log for /search and /company error details.');
  process.exit(1);
}

// Mass lock-misses mean the optimistic lock itself is broken (writes matching
// zero rows), not concurrency noise — the tiers share a workflow concurrency
// group, so legitimate misses are near-zero. This check would have caught the
// 2026-05-28 → 2026-07-07 silent freeze on its first run.
const LOCK_MISS_RATE_THRESHOLD = 0.5;
const lockMissRate =
  summary.selected > 0 ? summary.lockMissed / summary.selected : 0;
if (lockMissRate > LOCK_MISS_RATE_THRESHOLD) {
  console.error('');
  console.error(
    `  LOCK MISS RATE ${(lockMissRate * 100).toFixed(1)}% exceeds ${LOCK_MISS_RATE_THRESHOLD * 100}% threshold.`,
  );
  console.error(
    '  The optimistic lock is matching zero rows — writes are being discarded.',
  );
  console.error(
    '  Check verified_at param handling in src/lib/phase5/sql.ts (both lock',
  );
  console.error('  sides must be date_trunc-ed to milliseconds).');
  process.exit(1);
}
