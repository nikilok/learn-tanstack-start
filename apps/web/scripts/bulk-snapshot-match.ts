/**
 * Bulk snapshot matcher — offline recovery for the no_match backlog.
 *
 * Downloads the free monthly Companies House bulk file
 * (BasicCompanyDataAsOneFile, ~5.5M companies incl. up to 10 previous names
 * and RegAddress PostTown/County), streams it once against the no_match +
 * NULL-method backlog using the SAME pipeline matchers as the online
 * resolver, then re-verifies every winner against the live CH API (fresh
 * name/status/previous-names) before committing through applyPromotion
 * (decide() gate + optimistic lock + audit + profile upsert).
 *
 * This removes the two constraints the nightly sweep inherits from the
 * search API: the 20-result window and the request budget. It catches
 * typo'd names the search returns nothing for, matches ranked below the
 * search cutoff, and renames only visible via previous names.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/bulk-snapshot-match.ts --dry-run --max-verifications=25
 *   bun apps/web/scripts/bulk-snapshot-match.ts --snapshot-file=/tmp/BasicCompanyData.csv
 *   bun apps/web/scripts/bulk-snapshot-match.ts            # full run (CI)
 *
 * Env: POSTGRES_URL, COMPANIES_HOUSE_SEED_API_KEY (as phase5-sweep.ts).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { neon } from '@ss/db/client';
import { companiesHouseProfiles } from '@ss/db/schema';
import { parse } from 'csv-parse';
import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/neon-http';

import type {
  BacklogEntry,
  OfflineHit,
} from '../src/lib/bulk-match/backlog-index.ts';
import {
  buildBacklogIndex,
  matchSnapshotCompany,
} from '../src/lib/bulk-match/backlog-index.ts';
import { pickForOrg } from '../src/lib/bulk-match/pick-candidate.ts';
import {
  REQUIRED_SNAPSHOT_COLUMNS,
  snapshotRowToCompany,
} from '../src/lib/bulk-match/snapshot-row.ts';
import {
  type CHCandidate,
  matchesHmrcLocality,
  matchTierA,
  matchTierASquash,
  matchTierB,
  matchTierD,
  parseHmrcName,
  squashForComparison,
} from '../src/lib/hmrc-ch/pipeline.ts';
import { profileToDbRow } from '../src/lib/hmrc-ch/profile-row.ts';
import type { CHFullProfile } from '../src/lib/phase5/apply-promotion.ts';
import { applyPromotion } from '../src/lib/phase5/apply-promotion.ts';
import { describeDbHost } from '../src/lib/phase5/db-host.ts';
import type {
  ExistingMapping,
  MatchMethod,
  ProposedResolution,
} from '../src/lib/phase5/decide.ts';
import { decide } from '../src/lib/phase5/decide.ts';
import { makeCommitPromotion } from '../src/lib/phase5/sql.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Env + args
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(SCRIPT_DIR, '../../../.env.local') });
dotenv.config({ path: resolve(SCRIPT_DIR, '../.env.local') });

if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL not set');
const CH_API_KEY = process.env.COMPANIES_HOUSE_SEED_API_KEY;
if (!CH_API_KEY) throw new Error('COMPANIES_HOUSE_SEED_API_KEY not set');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const KEEP_FILES = args.includes('--keep-files');

/** Strict whole-number parse (mirrors phase5-sweep.ts). */
function parseStrictInt(raw: string, label: string, min: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label}="${raw}" — must be a whole integer`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < min) throw new Error(`Invalid ${label}="${raw}" — must be >= ${min}`);
  return n;
}

function argValue(name: string): string | undefined {
  return args
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(`--${name}=`.length);
}

const BACKLOG_LIMIT = argValue('backlog-limit')
  ? parseStrictInt(argValue('backlog-limit') as string, '--backlog-limit', 1)
  : undefined;
const MAX_VERIFICATIONS = argValue('max-verifications')
  ? parseStrictInt(
      argValue('max-verifications') as string,
      '--max-verifications',
      0,
    )
  : 2500;
const SNAPSHOT_FILE = argValue('snapshot-file');

// ─────────────────────────────────────────────────────────────────────────────
// CH API client (verify step) — same retry shape as phase5-sweep.ts
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.company-information.service.gov.uk';
const AUTH_HEADER = `Basic ${Buffer.from(`${CH_API_KEY}:`).toString('base64')}`;
const FETCH_MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Distinguishes "the company number genuinely isn't on the register" (404 →
 *  a real verify mismatch) from systemic failures (auth, outage, exhausted
 *  retries → errored, which trips the loud-failure guard). Collapsing both
 *  into null would let a dead API key finish the run green. */
type FetchOutcome =
  | { ok: true; data: unknown }
  | { ok: false; notFound: boolean };

async function fetchApi(
  path: string,
  retriesLeft = FETCH_MAX_RETRIES,
): Promise<FetchOutcome> {
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
      console.error(`  network error for ${path}, giving up: ${err}`);
      return { ok: false, notFound: false };
    }
    console.log(`  network error, backing off 60s… (${retriesLeft} left)`);
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
  clearTimeout(timeoutId);
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    if (retriesLeft <= 0) {
      console.error(`  ${res.status} retries exhausted for ${path}`);
      return { ok: false, notFound: false };
    }
    console.log(`  ${res.status}, backing off 60s… (${retriesLeft} left)`);
    await delay(60_000);
    return fetchApi(path, retriesLeft - 1);
  }
  if (res.status === 404 || res.status === 410) {
    return { ok: false, notFound: true };
  }
  if (!res.ok) {
    console.error(`  unexpected ${res.status} for ${path}`);
    return { ok: false, notFound: false };
  }
  return { ok: true, data: await res.json() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot download
// ─────────────────────────────────────────────────────────────────────────────

const DOWNLOAD_BASE = 'https://download.companieshouse.gov.uk';

/** Current month's file, falling back to last month's (the snapshot lands in
 *  the first days of each month). */
function snapshotUrlCandidates(now: Date): string[] {
  const monthStart = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  return [0, 1].map((offset) => {
    const d = monthStart(offset);
    const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
    return `${DOWNLOAD_BASE}/BasicCompanyDataAsOneFile-${stamp}.zip`;
  });
}

async function downloadSnapshot(workDir: string): Promise<string> {
  for (const url of snapshotUrlCandidates(new Date())) {
    console.log(`Downloading ${url} …`);
    const zipPath = join(workDir, basename(url));
    // curl, not fetch: streams ~470MB straight to disk with retries; -f turns
    // a 404 (snapshot not published yet) into the previous-month fallback.
    const dl = Bun.spawnSync([
      'curl',
      '-fsSL',
      '--retry',
      '3',
      '-o',
      zipPath,
      url,
    ]);
    if (dl.exitCode !== 0) {
      console.log(
        `  download failed (curl exit ${dl.exitCode}) — trying previous month`,
      );
      continue;
    }
    console.log(`  saved ${zipPath}`);
    const unzip = Bun.spawnSync(['unzip', '-o', zipPath, '-d', workDir]);
    if (unzip.exitCode !== 0) {
      throw new Error(`unzip failed: ${unzip.stderr.toString()}`);
    }
    const csv = readdirSync(workDir).find((f) => f.endsWith('.csv'));
    if (!csv) throw new Error('no CSV found inside snapshot zip');
    return join(workDir, csv);
  }
  throw new Error('no snapshot zip available for current or previous month');
}

// ─────────────────────────────────────────────────────────────────────────────
// DB wiring
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

type BacklogRow = {
  organisation_name: string;
  town_city: string | null;
  county: string | null;
};

/** no_match + legacy NULL-method rows, live register only; one deterministic
 *  worker row per org supplies the locality for Tier-D gating + tiebreaks. */
async function fetchBacklog(): Promise<BacklogRow[]> {
  if (BACKLOG_LIMIT !== undefined) {
    return (await sql`
      SELECT m.organisation_name, w.town_city, w.county
      FROM hmrc_company_mapping m
      JOIN LATERAL (
        SELECT town_city, county FROM hmrc_skilled_workers w
        WHERE w.organisation_name = m.organisation_name
        ORDER BY id ASC LIMIT 1
      ) w ON true
      WHERE m.match_method = 'no_match' OR m.match_method IS NULL
      ORDER BY m.organisation_name
      LIMIT ${BACKLOG_LIMIT}
    `) as BacklogRow[];
  }
  return (await sql`
    SELECT m.organisation_name, w.town_city, w.county
    FROM hmrc_company_mapping m
    JOIN LATERAL (
      SELECT town_city, county FROM hmrc_skilled_workers w
      WHERE w.organisation_name = m.organisation_name
      ORDER BY id ASC LIMIT 1
    ) w ON true
    WHERE m.match_method = 'no_match' OR m.match_method IS NULL
    ORDER BY m.organisation_name
  `) as BacklogRow[];
}

async function fetchExisting(org: string): Promise<ExistingMapping | null> {
  const rows = (await sql`
    SELECT organisation_name, company_number, match_method, match_score,
           verified_at, is_public_body
    FROM hmrc_company_mapping WHERE organisation_name = ${org}
  `) as {
    organisation_name: string;
    company_number: string | null;
    match_method: MatchMethod | null;
    match_score: string | null;
    verified_at: Date | null;
    is_public_body: boolean;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    organisationName: r.organisation_name,
    companyNumber: r.company_number,
    matchMethod: r.match_method,
    matchScore: r.match_score,
    verifiedAt: r.verified_at,
    isPublicBody: r.is_public_body,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live re-verification — snapshot staleness can never commit a wrong match
// ─────────────────────────────────────────────────────────────────────────────

type LiveVerdict = {
  matchMethod: 'exact' | 'exact_squash' | 'previous_name' | 'fuzzy_edit';
  matchScore: number;
};

function verifyAgainstLive(
  legal: string,
  profile: CHFullProfile,
  townCity: string | null,
  county: string | null,
): LiveVerdict | null {
  const address = (profile.registered_office_address ?? {}) as {
    locality?: string;
    region?: string;
  };
  const cand: CHCandidate = {
    company_number: profile.company_number,
    company_name: profile.company_name,
    company_status: profile.company_status ?? null,
    previous_company_names:
      (profile.previous_company_names as { name: string }[] | undefined)?.map(
        (p) => p.name,
      ) ?? null,
    locality: address.locality ?? null,
    region: address.region ?? null,
  };
  const a = matchTierA(legal, cand);
  if (a !== null) return { matchMethod: 'exact', matchScore: a };
  const a2 = matchTierASquash(legal, cand);
  if (a2 !== null) return { matchMethod: 'exact_squash', matchScore: a2 };
  const b = matchTierB(legal, cand);
  if (b !== null) return { matchMethod: 'previous_name', matchScore: b };
  // Fuzzy evidence keeps its resolver gates live: active + locality.
  if (
    profile.company_status === 'active' &&
    matchesHmrcLocality(cand, townCity, county)
  ) {
    const d = matchTierD(legal, cand);
    if (d !== null) return { matchMethod: 'fuzzy_edit', matchScore: d };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
console.log(
  `Bulk snapshot match${DRY_RUN ? ' (DRY RUN — no writes)' : ''} — max_verifications=${MAX_VERIFICATIONS}`,
);
console.log(`  db host      : ${describeDbHost(process.env.POSTGRES_URL)}`);
console.log('───────────────────────────────────────────────────────────');

const backlogRows = await fetchBacklog();
let skippedPublicBody = 0;
let skippedDegenerate = 0;
const entries: BacklogEntry[] = [];
for (const row of backlogRows) {
  const parsed = parseHmrcName(row.organisation_name);
  if (parsed.isPublicBody) {
    skippedPublicBody += 1;
    continue;
  }
  const squash = squashForComparison(parsed.parsedLegal);
  if (squash.length === 0) {
    skippedDegenerate += 1;
    continue;
  }
  entries.push({
    organisationName: row.organisation_name,
    legal: parsed.parsedLegal,
    squash,
    townCity: row.town_city,
    county: row.county,
  });
}
const index = buildBacklogIndex(entries);
const entryByOrg = new Map(entries.map((e) => [e.organisationName, e]));
console.log(
  `Backlog: ${backlogRows.length} rows → ${entries.length} matchable (${skippedPublicBody} public-body, ${skippedDegenerate} degenerate)`,
);

const workDir = mkdtempSync(join(tmpdir(), 'ch-snapshot-'));
const csvPath = SNAPSHOT_FILE ?? (await downloadSnapshot(workDir));
if (!existsSync(csvPath)) throw new Error(`snapshot csv missing: ${csvPath}`);
console.log(`Streaming ${csvPath} …`);

const hitsByOrg = new Map<string, OfflineHit[]>();
let snapshotRows = 0;
let columnsValidated = false;

const parser = createReadStream(csvPath).pipe(
  parse({
    columns: (header: string[]) => header.map((h) => h.trim()),
    bom: true,
    trim: true,
    // The CH file contains occasional blank and ragged lines mid-file;
    // short rows parse with undefined trailing fields and are dropped by
    // snapshotRowToCompany's guards.
    skip_empty_lines: true,
    relax_column_count: true,
  }),
);
for await (const record of parser as AsyncIterable<Record<string, string>>) {
  if (!columnsValidated) {
    const missing = REQUIRED_SNAPSHOT_COLUMNS.filter((c) => !(c in record));
    if (missing.length > 0) {
      console.error(`Snapshot format changed — missing: ${missing.join(', ')}`);
      console.error(`Found columns: ${Object.keys(record).join(', ')}`);
      process.exit(1);
    }
    columnsValidated = true;
  }
  snapshotRows += 1;
  if (snapshotRows % 1_000_000 === 0) {
    console.log(`  …${snapshotRows / 1_000_000}M rows scanned`);
  }
  const company = snapshotRowToCompany(record);
  if (!company) continue;
  for (const hit of matchSnapshotCompany(index, company)) {
    const bucket = hitsByOrg.get(hit.entry.organisationName);
    if (bucket) bucket.push(hit);
    else hitsByOrg.set(hit.entry.organisationName, [hit]);
  }
}
console.log(`Scanned ${snapshotRows} snapshot rows`);

const TIER_SORT: Record<string, number> = { A: 0, A2: 1, B: 2, D: 3 };
let tied = 0;
const picks: OfflineHit[] = [];
for (const [org, hits] of hitsByOrg) {
  const entry = entryByOrg.get(org);
  if (!entry) continue;
  const outcome = pickForOrg(hits, entry.townCity, entry.county);
  if (outcome.kind === 'picked') picks.push(outcome.hit);
  else if (outcome.kind === 'tied') tied += 1;
}
picks.sort(
  (a, b) =>
    TIER_SORT[a.tier] - TIER_SORT[b.tier] ||
    a.entry.organisationName.localeCompare(b.entry.organisationName),
);
const cappedOut = Math.max(0, picks.length - MAX_VERIFICATIONS);
const toVerify = picks.slice(0, MAX_VERIFICATIONS);
if (cappedOut > 0) {
  console.log(
    `NOTE: ${cappedOut} matched orgs beyond --max-verifications=${MAX_VERIFICATIONS} — they stay in the backlog for the next run.`,
  );
}

const tierCounts = new Map<string, number>();
for (const p of picks) {
  tierCounts.set(p.tier, (tierCounts.get(p.tier) ?? 0) + 1);
}
console.log(
  `Matched ${picks.length} orgs (${[...tierCounts.entries()]
    .map(([t, n]) => `${t}:${n}`)
    .join(' ')}), ${tied} tied/ambiguous`,
);

let verifiedConfirmed = 0;
let verifyMismatch = 0;
let committed = 0;
let wouldCommit = 0;
let decideSkipped = 0;
let lockMissed = 0;
let errored = 0;

const applyDeps = { commitPromotion: makeCommitPromotion(sql), upsertProfile };

for (let i = 0; i < toVerify.length; i += 1) {
  if (i > 0) await delay(550);
  const pick = toVerify[i];
  const org = pick.entry.organisationName;
  try {
    const res = await fetchApi(
      `/company/${encodeURIComponent(pick.company.companyNumber)}`,
    );
    if (!res.ok) {
      if (res.notFound) {
        verifyMismatch += 1; // number gone from the register since the snapshot
      } else {
        errored += 1;
        if (errored >= 10 && verifiedConfirmed === 0) {
          console.error(
            '  first verifications are all failing — aborting loop (systemic CH failure)',
          );
          break;
        }
      }
      continue;
    }
    const profile = res.data as CHFullProfile;
    const verdict = verifyAgainstLive(
      pick.entry.legal,
      profile,
      pick.entry.townCity,
      pick.entry.county,
    );
    if (!verdict) {
      verifyMismatch += 1;
      continue;
    }
    verifiedConfirmed += 1;

    const existing = await fetchExisting(org);
    if (!existing) {
      decideSkipped += 1;
      continue;
    }
    const proposed: ProposedResolution = {
      verdict: 'verified',
      companyNumber: profile.company_number,
      matchMethod: verdict.matchMethod,
      matchScore: verdict.matchScore,
      queryUsed: `bulk:${basename(csvPath)}`,
      profile,
    };
    const decision = decide(existing, proposed);
    if (decision.action !== 'update') {
      decideSkipped += 1;
      continue;
    }
    if (DRY_RUN) {
      wouldCommit += 1;
      console.log(
        `  [dry] ${verdict.matchMethod.padEnd(13)} ${verdict.matchScore.toFixed(2)} | ${org} → ${profile.company_name} (${profile.company_number})`,
      );
      continue;
    }
    const result = await applyPromotion(
      existing,
      proposed,
      'bulk_snapshot',
      applyDeps,
    );
    if (result.ok) {
      committed += 1;
      console.log(
        `  ✓ ${verdict.matchMethod.padEnd(13)} ${verdict.matchScore.toFixed(2)} | ${org} → ${profile.company_name} (${profile.company_number})`,
      );
    } else {
      lockMissed += 1;
    }
  } catch (err) {
    errored += 1;
    console.error(`  row "${org}" errored:`, err);
  }
}

if (!KEEP_FILES && !SNAPSHOT_FILE) {
  rmSync(workDir, { recursive: true, force: true });
}

const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log('');
console.log(`  backlog             : ${backlogRows.length}`);
console.log(`  matchable           : ${entries.length}`);
console.log(`  snapshot_rows       : ${snapshotRows}`);
console.log(`  orgs_matched        : ${picks.length}`);
console.log(`  tied_ambiguous      : ${tied}`);
console.log(`  selected_to_verify  : ${toVerify.length}`);
console.log(`  capped_out          : ${cappedOut}`);
console.log(`  verified_confirmed  : ${verifiedConfirmed}`);
console.log(`  verify_mismatch     : ${verifyMismatch}`);
console.log(`  committed           : ${committed}`);
console.log(`  dry_run_would_commit: ${wouldCommit}`);
console.log(`  decide_skipped      : ${decideSkipped}`);
console.log(`  lock_missed         : ${lockMissed}`);
console.log(`  errored             : ${errored}`);
console.log(`  duration            : ${durationSec}s`);

// Same loud-failure posture as the sweep: mass errors or mass lock misses
// mean something systemic broke — fail the workflow so it emails.
if (toVerify.length > 0 && errored / toVerify.length > 0.25) {
  console.error('  ERROR RATE above 25% — check CH API auth/availability.');
  process.exit(1);
}
if (toVerify.length > 0 && lockMissed / toVerify.length > 0.5) {
  console.error('  LOCK MISS RATE above 50% — optimistic lock is broken.');
  process.exit(1);
}
