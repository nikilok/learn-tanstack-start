/**
 * One-shot drain for `hmrc_company_mapping_review_queue`. Resolves every
 * unresolved row via one of two strategies:
 *
 *   trust   — every row swaps to its `proposed_company_number`. Based on
 *             manual verification of the data, the resolver's proposed picks
 *             are consistently the right entity. No scoring, no inconclusive
 *             bucket. Audit changed_by = 'drain_trust'.
 *   scorer  — runs `compareForInlineResolution` (the same helper the live
 *             sweep will call). Dispatches to swap / keep / inconclusive.
 *             Audit changed_by = 'drain_scorer'.
 *
 * Both strategies write through `applyPromotion`, so the optimistic lock on
 * `verified_at` and the audit-INSERT side-effect are identical to a normal
 * sweep promotion.
 *
 * Modes:
 *   --compare              dry-run both strategies, emit comparison report
 *   --strategy=X --apply   apply the chosen strategy (X = trust|scorer)
 *   --strategy=X --apply --limit=N  partial drain (spot-check before full)
 *
 * Profiles are read from `companies_house_profiles` (must be hydrated first
 * via `hydrate-queue-proposed-profiles.ts`). Zero CH API calls in this script.
 *
 * Delete this script after `hmrc_company_mapping_review_queue` is dropped.
 *
 * See docs/phase5-sweep-algorithm.md §"Migration of the existing 190 rows".
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { neon } from '@ss/db/client';
import dotenv from 'dotenv';

import type { CompareCandidate } from '../src/lib/phase5/compare-candidates.ts';
import { compareForInlineResolution } from '../src/lib/phase5/compare-candidates.ts';
import type {
  ApplyPromotionDeps,
  CHFullProfile,
} from '../src/lib/phase5/apply-promotion.ts';
import { applyPromotion } from '../src/lib/phase5/apply-promotion.ts';
import { describeDbHost } from '../src/lib/phase5/db-host.ts';
import type { ScorerSponsor } from '../src/lib/phase5/score-candidate.ts';
import { makeCommitPromotion } from '../src/lib/phase5/sql.ts';
import type {
  ExistingMapping,
  MatchMethod,
  ProposedResolution,
} from '../src/lib/phase5/decide.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Env loading
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const ROOT_ENV = resolve(REPO_ROOT, '.env.local');
const APP_ENV = resolve(SCRIPT_DIR, '../.env.local');
dotenv.config({ path: ROOT_ENV });
dotenv.config({ path: APP_ENV });

if (!process.env.POSTGRES_URL) {
  throw new Error(`POSTGRES_URL not in ${ROOT_ENV} or ${APP_ENV}`);
}

const sql = neon(process.env.POSTGRES_URL);

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const COMPARE = args.includes('--compare');
const APPLY = args.includes('--apply');
const strategyArg = args.find((a) => a.startsWith('--strategy='));
const limitArg = args.find((a) => a.startsWith('--limit='));

if (COMPARE && APPLY) {
  throw new Error('Pass either --compare or --apply, not both.');
}
if (!COMPARE && !APPLY) {
  throw new Error(
    'Pass --compare (dry-run report) or --strategy=<trust|scorer> --apply.',
  );
}

type StrategyName = 'trust' | 'scorer';

const STRATEGY: StrategyName | null = strategyArg
  ? (strategyArg.replace('--strategy=', '') as StrategyName)
  : null;

if (APPLY) {
  if (STRATEGY === null) {
    throw new Error('--apply requires --strategy=<trust|scorer>.');
  }
  if (STRATEGY !== 'trust' && STRATEGY !== 'scorer') {
    throw new Error(`Invalid --strategy="${STRATEGY}". Use trust or scorer.`);
  }
}

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
// Types
// ─────────────────────────────────────────────────────────────────────────────

type QueueRow = {
  id: number;
  organisation_name: string;
  existing_company_number: string | null;
  existing_match_method: MatchMethod | null;
  existing_match_score: string | null;
  proposed_company_number: string | null;
  proposed_match_method: MatchMethod | null;
  proposed_match_score: string | null;
  proposed_query_used: string | null;
};

type ProfileRow = {
  company_number: string;
  company_name: string;
  company_status: string | null;
  company_type: string | null;
  locality: string | null;
  previous_company_names: string[] | null;
};

type SponsorRow = { town_city: string | null; route: string };

type StrategyOutcome =
  | { action: 'swap'; reason: string; s_e?: number; s_p?: number }
  | { action: 'keep'; reason: string; s_e: number; s_p: number }
  | { action: 'inconclusive'; reason: string; s_e: number; s_p: number }
  | { action: 'orphan'; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

async function loadUnresolvedQueue(): Promise<QueueRow[]> {
  return (await sql`
    SELECT id, organisation_name,
           existing_company_number, existing_match_method, existing_match_score,
           proposed_company_number, proposed_match_method, proposed_match_score,
           proposed_query_used
      FROM hmrc_company_mapping_review_queue
     WHERE resolved_at IS NULL
     ORDER BY id
  `) as QueueRow[];
}

async function loadProfiles(
  numbers: string[],
): Promise<Map<string, ProfileRow>> {
  if (numbers.length === 0) return new Map();
  const rows = (await sql`
    SELECT company_number, company_name, company_status, company_type,
           locality, previous_company_names
      FROM companies_house_profiles
     WHERE company_number = ANY(${numbers})
  `) as ProfileRow[];
  return new Map(rows.map((r) => [r.company_number, r]));
}

/** Picks the most common (town_city, route) tuple per organisation_name.
 *  HMRC publishes one row per worker, so an org with mixed routes/locations
 *  picks the dominant pairing — same heuristic the inline scorer will use. */
async function loadSponsors(
  orgNames: string[],
): Promise<Map<string, SponsorRow>> {
  if (orgNames.length === 0) return new Map();
  const rows = (await sql`
    SELECT DISTINCT ON (organisation_name)
           organisation_name, town_city, route
      FROM (
        SELECT organisation_name, town_city, route, COUNT(*) AS n
          FROM hmrc_skilled_workers
         WHERE organisation_name = ANY(${orgNames})
         GROUP BY organisation_name, town_city, route
      ) ranked
     ORDER BY organisation_name, n DESC, route
  `) as { organisation_name: string; town_city: string | null; route: string }[];
  return new Map(rows.map((r) => [r.organisation_name, r]));
}

async function loadCurrentMapping(
  orgName: string,
): Promise<ExistingMapping | null> {
  const rows = (await sql`
    SELECT organisation_name, company_number, match_method, match_score,
           verified_at, is_public_body
      FROM hmrc_company_mapping
     WHERE organisation_name = ${orgName}
  `) as {
    organisation_name: string;
    company_number: string | null;
    match_method: MatchMethod | null;
    match_score: string | null;
    verified_at: Date | null;
    is_public_body: boolean;
  }[];
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    organisationName: r.organisation_name,
    companyNumber: r.company_number,
    matchMethod: r.match_method,
    matchScore: r.match_score,
    verifiedAt: r.verified_at,
    isPublicBody: r.is_public_body,
  };
}

async function markResolved(
  id: number,
  resolution: string,
  by: string,
): Promise<void> {
  await sql`
    UPDATE hmrc_company_mapping_review_queue
       SET resolved_at = NOW(),
           resolved_by = ${by},
           resolution = ${resolution}
     WHERE id = ${id}
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile shape adapters
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a flat `companies_house_profiles` row into the structural shape
 *  the scorer and comparer read (mirrors the CH `/company/{number}` JSON). */
function profileRowToCompareCandidate(row: ProfileRow): CompareCandidate {
  return {
    company_name: row.company_name,
    company_status: row.company_status,
    type: row.company_type,
    registered_office_address: { locality: row.locality },
    previous_company_names: (row.previous_company_names ?? []).map((name) => ({
      name,
    })),
  };
}

/** Reconstruct the resolver's `CHFullProfile` shape from a cached profile row.
 *  Used to feed `applyPromotion` so the conditional profile UPSERT side of the
 *  CTE has a payload — although the row is already in cache, applyPromotion
 *  will UPSERT it again (idempotent). */
function profileRowToFullProfile(row: ProfileRow): CHFullProfile {
  return {
    company_number: row.company_number,
    company_name: row.company_name,
    company_status: row.company_status ?? undefined,
    type: row.company_type ?? undefined,
    registered_office_address: row.locality
      ? { locality: row.locality }
      : undefined,
    previous_company_names: (row.previous_company_names ?? []).map((name) => ({
      name,
    })),
  };
}

function sponsorRowToScorerSponsor(row: SponsorRow): ScorerSponsor {
  return { route: row.route, townCity: row.town_city };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategies — pure functions, no I/O
// ─────────────────────────────────────────────────────────────────────────────

function trustStrategy(): StrategyOutcome {
  return { action: 'swap', reason: 'trust strategy: unconditional swap' };
}

function scorerStrategy(
  existing: ProfileRow | undefined,
  proposed: ProfileRow | undefined,
  sponsor: SponsorRow | undefined,
): StrategyOutcome {
  if (!sponsor) {
    return { action: 'orphan', reason: 'no sponsor record' };
  }
  if (!existing) {
    return { action: 'orphan', reason: 'existing profile missing from cache' };
  }
  if (!proposed) {
    return { action: 'orphan', reason: 'proposed profile missing from cache' };
  }
  const result = compareForInlineResolution(
    profileRowToCompareCandidate(existing),
    profileRowToCompareCandidate(proposed),
    sponsorRowToScorerSponsor(sponsor),
  );
  const reason = `s_e=${formatScore(result.s_e)} s_p=${formatScore(result.s_p)}`;
  if (result.action === 'promote') {
    return { action: 'swap', reason, s_e: result.s_e, s_p: result.s_p };
  }
  if (result.action === 'keep') {
    return { action: 'keep', reason, s_e: result.s_e, s_p: result.s_p };
  }
  return {
    action: 'inconclusive',
    reason,
    s_e: result.s_e,
    s_p: result.s_p,
  };
}

function formatScore(n: number): string {
  if (n === Number.NEGATIVE_INFINITY) return '-∞';
  if (n === Number.POSITIVE_INFINITY) return '+∞';
  return n.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare mode — run both strategies, emit markdown report
// ─────────────────────────────────────────────────────────────────────────────

type CompareRow = {
  org: string;
  e_num: string | null;
  p_num: string | null;
  trust: StrategyOutcome['action'];
  scorer: StrategyOutcome['action'];
  s_e: number | undefined;
  s_p: number | undefined;
  reason: string;
};

/** Lower priority sorts first. Disagreement-first ordering: scorer=keep is the
 *  loudest disagreement, then inconclusive, then orphan, then both-agree. */
function comparePriority(row: CompareRow): number {
  if (row.trust === row.scorer) return 4; // both agree
  if (row.scorer === 'keep') return 0;
  if (row.scorer === 'inconclusive') return 1;
  if (row.scorer === 'orphan') return 2;
  return 3;
}

function describeDisagreement(row: CompareRow): string {
  if (row.trust === row.scorer) return 'both agree';
  if (row.scorer === 'keep') return 'scorer disagrees';
  if (row.scorer === 'inconclusive') return 'scorer uncertain';
  if (row.scorer === 'orphan') return row.reason;
  return row.reason;
}

async function runCompare(): Promise<void> {
  const queue = await loadUnresolvedQueue();
  const sliced = limit !== undefined ? queue.slice(0, limit) : queue;

  console.log(`  queue rows (unresolved) : ${queue.length}`);
  if (limit !== undefined) console.log(`  scoring                 : ${sliced.length}`);

  const numbers = uniq(
    sliced.flatMap((r) => [
      r.existing_company_number,
      r.proposed_company_number,
    ]),
  ).filter((n): n is string => n !== null);
  const profiles = await loadProfiles(numbers);
  const sponsors = await loadSponsors(uniq(sliced.map((r) => r.organisation_name)));

  const rows: CompareRow[] = sliced.map((r) => {
    const existing = r.existing_company_number
      ? profiles.get(r.existing_company_number)
      : undefined;
    const proposed = r.proposed_company_number
      ? profiles.get(r.proposed_company_number)
      : undefined;
    const sponsor = sponsors.get(r.organisation_name);

    const t = trustStrategy();
    const s = scorerStrategy(existing, proposed, sponsor);

    return {
      org: r.organisation_name,
      e_num: r.existing_company_number,
      p_num: r.proposed_company_number,
      trust: t.action,
      scorer: s.action,
      s_e: s.action === 'swap' || s.action === 'keep' || s.action === 'inconclusive' ? s.s_e : undefined,
      s_p: s.action === 'swap' || s.action === 'keep' || s.action === 'inconclusive' ? s.s_p : undefined,
      reason: s.reason,
    };
  });

  rows.sort((a, b) => {
    const da = comparePriority(a);
    const db = comparePriority(b);
    if (da !== db) return da - db;
    return a.org.localeCompare(b.org);
  });

  const tallies = countBy(rows, (r) => `${r.trust}/${r.scorer}`);

  const reportPath = resolve(REPO_ROOT, 'docs/phase5-drain-comparison.md');
  const md = buildMarkdownReport(rows, tallies, queue.length, sliced.length);
  await writeFile(reportPath, md, 'utf8');

  console.log('');
  console.log('  tallies (trust / scorer):');
  for (const [k, v] of Object.entries(tallies)) {
    console.log(`    ${k.padEnd(24)} ${v}`);
  }
  console.log('');
  console.log(`  report written to: docs/phase5-drain-comparison.md`);
}

function buildMarkdownReport(
  rows: CompareRow[],
  tallies: Record<string, number>,
  totalQueue: number,
  scoredCount: number,
): string {
  const header = [
    '# Phase 5 drain — strategy comparison',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Queue rows unresolved: ${totalQueue}`,
    `Scored in this report: ${scoredCount}`,
    '',
    '## Tallies (trust / scorer)',
    '',
    '| trust | scorer | count |',
    '|---|---|---|',
  ];
  const tallyRows = Object.entries(tallies)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => {
      const [t, s] = k.split('/');
      return `| ${t} | ${s} | ${v} |`;
    });

  const tableHeader = [
    '',
    '## Per-row decisions (disagreement-first)',
    '',
    '| org | e_num → p_num | trust | scorer | s_e | s_p | reason |',
    '|---|---|---|---|---|---|---|',
  ];

  const tableRows = rows.map((r) => {
    const orgSafe = r.org.replace(/\|/g, '\\|');
    const numCol = `${r.e_num ?? '—'} → ${r.p_num ?? '—'}`;
    const seCell = r.s_e !== undefined ? formatScore(r.s_e) : '—';
    const spCell = r.s_p !== undefined ? formatScore(r.s_p) : '—';
    const reasonSafe = describeDisagreement(r).replace(/\|/g, '\\|');
    return `| ${orgSafe} | ${numCol} | ${r.trust} | ${r.scorer} | ${seCell} | ${spCell} | ${reasonSafe} |`;
  });

  return [...header, ...tallyRows, ...tableHeader, ...tableRows, ''].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply mode
// ─────────────────────────────────────────────────────────────────────────────

async function runApply(strategy: StrategyName): Promise<void> {
  const queue = await loadUnresolvedQueue();
  const sliced = limit !== undefined ? queue.slice(0, limit) : queue;

  console.log(`  queue rows (unresolved) : ${queue.length}`);
  console.log(`  applying strategy       : ${strategy}`);
  if (limit !== undefined) console.log(`  draining                : ${sliced.length}`);

  const numbers = uniq(
    sliced.flatMap((r) => [
      r.existing_company_number,
      r.proposed_company_number,
    ]),
  ).filter((n): n is string => n !== null);
  const profiles = await loadProfiles(numbers);
  const sponsors = await loadSponsors(uniq(sliced.map((r) => r.organisation_name)));

  // No-op upsertProfile — profiles are already cached from the hydrate step,
  // and the drain works entirely from cache. applyPromotion will still call
  // this in the `verified` branch, but the cache row is the source of truth.
  const applyDeps: ApplyPromotionDeps = {
    commitPromotion: makeCommitPromotion(sql),
    upsertProfile: async () => {},
  };
  const changedBy = `drain_${strategy}`;

  let swapped = 0;
  let kept = 0;
  let inconclusive = 0;
  let orphaned = 0;
  let stale = 0;
  let lockMissed = 0;

  for (let i = 0; i < sliced.length; i++) {
    const r = sliced[i];
    const idx = `[${i + 1}/${sliced.length}]`;
    const existing = r.existing_company_number
      ? profiles.get(r.existing_company_number)
      : undefined;
    const proposed = r.proposed_company_number
      ? profiles.get(r.proposed_company_number)
      : undefined;
    const sponsor = sponsors.get(r.organisation_name);

    const outcome =
      strategy === 'trust'
        ? trustStrategy()
        : scorerStrategy(existing, proposed, sponsor);

    if (outcome.action === 'orphan') {
      orphaned += 1;
      await markResolved(r.id, `drain_${strategy}_orphan`, changedBy);
      console.log(`  ${idx} ${r.organisation_name} → orphan (${outcome.reason})`);
      continue;
    }

    if (outcome.action === 'keep') {
      kept += 1;
      await markResolved(r.id, `drain_${strategy}_keep`, changedBy);
      console.log(`  ${idx} ${r.organisation_name} → keep (${outcome.reason})`);
      continue;
    }

    if (outcome.action === 'inconclusive') {
      inconclusive += 1;
      await markResolved(r.id, `drain_${strategy}_inconclusive`, changedBy);
      console.log(`  ${idx} ${r.organisation_name} → inconclusive (${outcome.reason})`);
      continue;
    }

    // swap path — needs staleness check + applyPromotion
    const mapping = await loadCurrentMapping(r.organisation_name);
    if (!mapping) {
      orphaned += 1;
      await markResolved(r.id, `drain_${strategy}_stale`, changedBy);
      console.log(`  ${idx} ${r.organisation_name} → stale (no mapping row)`);
      continue;
    }
    if (mapping.companyNumber !== r.existing_company_number) {
      stale += 1;
      await markResolved(r.id, `drain_${strategy}_stale`, changedBy);
      console.log(
        `  ${idx} ${r.organisation_name} → stale (mapping moved ${r.existing_company_number} → ${mapping.companyNumber})`,
      );
      continue;
    }

    if (!proposed || !r.proposed_company_number) {
      orphaned += 1;
      await markResolved(r.id, `drain_${strategy}_orphan`, changedBy);
      console.log(`  ${idx} ${r.organisation_name} → orphan (proposed profile missing)`);
      continue;
    }

    const proposedResolution: ProposedResolution = {
      verdict: 'verified',
      companyNumber: r.proposed_company_number,
      matchMethod: r.proposed_match_method,
      matchScore: r.proposed_match_score ? Number(r.proposed_match_score) : null,
      queryUsed: r.proposed_query_used,
      profile: profileRowToFullProfile(proposed),
    };

    const result = await applyPromotion(
      mapping,
      proposedResolution,
      changedBy,
      applyDeps,
    );

    if (!result.ok) {
      lockMissed += 1;
      console.log(
        `  ${idx} ${r.organisation_name} → lock_missed (mapping verified_at changed; queue row stays unresolved)`,
      );
      continue;
    }

    swapped += 1;
    await markResolved(r.id, `drain_${strategy}_swap`, changedBy);
    if ((i + 1) % 25 === 0 || i + 1 === sliced.length) {
      console.log(
        `  ${idx} ${r.organisation_name} → swap (${swapped} swapped, ${kept} kept, ${inconclusive} inconclusive, ${orphaned} orphan)`,
      );
    }
  }

  console.log('');
  console.log(`  swapped       : ${swapped}`);
  console.log(`  kept          : ${kept}`);
  console.log(`  inconclusive  : ${inconclusive}`);
  console.log(`  orphaned      : ${orphaned}`);
  console.log(`  stale         : ${stale}`);
  console.log(`  lock_missed   : ${lockMissed}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function countBy<T>(
  arr: T[],
  keyOf: (item: T) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) {
    const k = keyOf(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log(
  `Drain review queue${COMPARE ? ' — compare mode (no writes)' : ` — apply mode (strategy=${STRATEGY})`}${limit !== undefined ? ` limit=${limit}` : ''}`,
);
console.log(`  db host      : ${describeDbHost(process.env.POSTGRES_URL)}`);
console.log('───────────────────────────────────────────────────────────');

if (COMPARE) {
  await runCompare();
} else {
  // STRATEGY validated above when APPLY is true
  await runApply(STRATEGY as StrategyName);
}
