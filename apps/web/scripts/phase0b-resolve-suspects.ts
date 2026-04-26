/**
 * Phase 0b — resolve `suspect_no_local_alternative` rows via Companies House search.
 *
 * Picks up where Phase 0a left off. For each row in
 * `hmrc_company_mapping_audit_phase0a` whose verdict is
 * `suspect_no_local_alternative`, searches CH using ONLY the parsed legal
 * candidate (Policy A — never falls back to trading-name search to avoid
 * mapping franchisees to their brand owners), scores results via Tier A/B/C,
 * and updates the staging row with the final verdict.
 *
 * - Caches every CH response to disk (apps/web/.cache/phase0b/) so re-runs
 *   are nearly free after threshold tuning or bug fixes.
 * - Resumable: re-running skips rows whose verdict has already been updated.
 * - Single-process at ~1.8 req/sec (DELAY_MS=550) to stay within CH's
 *   600-requests-per-5-minutes limit.
 *
 * Run from monorepo root:  bun apps/web/scripts/phase0b-resolve-suspects.ts
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@ss/db/client';
import dotenv from 'dotenv';
import {
  type CHCandidate,
  matchTierA,
  matchTierB,
  matchTierC,
  parseLegalCandidate,
  pickByLocality,
  type ScoredCandidate,
} from './lib/hmrc-ch-pipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Env loading — POSTGRES_URL lives at monorepo root, COMPANIES_HOUSE_SEED_API_KEY at apps/web/.env.local
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(SCRIPT_DIR, '../../../.env.local');
const APP_ENV = resolve(SCRIPT_DIR, '../.env.local');
dotenv.config({ path: ROOT_ENV });
dotenv.config({ path: APP_ENV, override: false });

if (!process.env.POSTGRES_URL)
  throw new Error(`POSTGRES_URL not in ${ROOT_ENV}`);
if (!process.env.COMPANIES_HOUSE_SEED_API_KEY)
  throw new Error(`COMPANIES_HOUSE_SEED_API_KEY not in ${APP_ENV}`);

const sql = neon(process.env.POSTGRES_URL);
const API_KEY = process.env.COMPANIES_HOUSE_SEED_API_KEY;
const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.company-information.service.gov.uk';
const DELAY_MS = 550; // ~1.8 req/sec, matches seed-companies-house.ts
const SEARCH_PAGE_SIZE = 20;
const TIER_B_PROFILE_FETCH_TOP_N = 3; // fetch profiles for top-N when Tier A misses, to enable Tier B
const PROGRESS_EVERY = 100;
const INTERIM_SUMMARY_EVERY = 1000;
const CACHE_DIR = resolve(SCRIPT_DIR, '../.cache/phase0b');

// ─────────────────────────────────────────────────────────────────────────────
// Types specific to Phase 0b's CH-search pipeline (CHCandidate / ScoredCandidate live in the shared lib)
// ─────────────────────────────────────────────────────────────────────────────

type CHSearchItem = {
  company_number: string;
  title: string;
  company_status?: string;
  address?: { locality?: string; region?: string };
  matches?: Record<string, unknown>;
};

type CHSearchResponse = { items?: CHSearchItem[] } | null;

type CHFullProfile = {
  company_number: string;
  company_name: string;
  company_status?: string;
  previous_company_names?: { name: string }[];
  registered_office_address?: { locality?: string; region?: string };
} | null;

type SuspectRow = {
  organisation_name: string;
  current_company_number: string;
  current_ch_name: string;
  parsed_legal_name: string;
  hmrc_town_city: string | null;
  hmrc_county: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// CH API client with disk cache
// ─────────────────────────────────────────────────────────────────────────────

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function cachePath(kind: 'search' | 'profile', key: string): string {
  const hash = createHash('sha256')
    .update(`${kind}:${key}`)
    .digest('hex')
    .slice(0, 16);
  return resolve(CACHE_DIR, `${kind}-${hash}-${slugify(key)}.json`);
}

let apiCallsMade = 0;

async function fetchApi(path: string): Promise<unknown | null> {
  await sleep(DELAY_MS);
  apiCallsMade++;
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: AUTH_HEADER },
  });
  if (res.status === 429) {
    console.log('  rate limited (429), backing off 60s…');
    await sleep(60_000);
    return fetchApi(path);
  }
  if (!res.ok) return null;
  return res.json();
}

async function searchCh(query: string): Promise<CHSearchResponse> {
  const path = cachePath('search', query);
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    return cached.response;
  }
  const response = (await fetchApi(
    `/search/companies?q=${encodeURIComponent(query)}&items_per_page=${SEARCH_PAGE_SIZE}`,
  )) as CHSearchResponse;
  writeFileSync(
    path,
    JSON.stringify({ query, fetched_at: new Date().toISOString(), response }),
  );
  return response;
}

async function fetchProfile(companyNumber: string): Promise<CHFullProfile> {
  const path = cachePath('profile', companyNumber);
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    return cached.response;
  }
  const response = (await fetchApi(
    `/company/${encodeURIComponent(companyNumber)}`,
  )) as CHFullProfile;
  writeFileSync(
    path,
    JSON.stringify({
      company_number: companyNumber,
      fetched_at: new Date().toISOString(),
      response,
    }),
  );
  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-row processing
// ─────────────────────────────────────────────────────────────────────────────

function searchItemToCandidate(item: CHSearchItem): CHCandidate {
  return {
    company_number: item.company_number,
    company_name: item.title,
    company_status: item.company_status ?? null,
    previous_company_names: null, // not in search payload — needs profile fetch for Tier B
    locality: item.address?.locality ?? null,
    region: item.address?.region ?? null,
  };
}

function profileToCandidate(p: NonNullable<CHFullProfile>): CHCandidate {
  return {
    company_number: p.company_number,
    company_name: p.company_name,
    company_status: p.company_status ?? null,
    previous_company_names:
      p.previous_company_names?.map((x) => x.name) ?? null,
    locality: p.registered_office_address?.locality ?? null,
    region: p.registered_office_address?.region ?? null,
  };
}

type ProcessOutcome =
  | {
      verdict: 'verified_via_ch_search';
      picked: ScoredCandidate;
      top5: CHSearchItem[];
    }
  | { verdict: 'no_match_after_ch_search'; top5: CHSearchItem[] }
  | {
      verdict: 'requires_human_review_ch';
      contenders: ScoredCandidate[];
      top5: CHSearchItem[];
    };

/** Runs the Phase 0b pipeline for a single row (search → score → tiebreak). */
async function processRow(row: SuspectRow): Promise<ProcessOutcome> {
  const legal =
    row.parsed_legal_name || parseLegalCandidate(row.organisation_name);
  const search = await searchCh(legal);
  const items = search?.items ?? [];
  const top5 = items.slice(0, 5);

  if (items.length === 0) {
    return { verdict: 'no_match_after_ch_search', top5 };
  }

  const tierAB: ScoredCandidate[] = [];
  for (const item of items) {
    const cand = searchItemToCandidate(item);
    const a = matchTierA(legal, cand);
    if (a !== null) {
      tierAB.push({ candidate: cand, tier: 'A', score: a });
    }
  }

  if (tierAB.length === 0) {
    for (const item of items.slice(0, TIER_B_PROFILE_FETCH_TOP_N)) {
      const profile = await fetchProfile(item.company_number);
      if (!profile) continue;
      const cand = profileToCandidate(profile);
      const b = matchTierB(legal, cand);
      if (b !== null) {
        tierAB.push({ candidate: cand, tier: 'B', score: b });
      }
    }
  }

  if (tierAB.length > 0) {
    const picked = pickByLocality(tierAB, row.hmrc_town_city, row.hmrc_county);
    if (picked === 'tied')
      return {
        verdict: 'requires_human_review_ch',
        contenders: tierAB.slice(0, 5),
        top5,
      };
    return { verdict: 'verified_via_ch_search', picked, top5 };
  }

  const tierC: ScoredCandidate[] = [];
  for (const item of items) {
    const cand = searchItemToCandidate(item);
    const c = matchTierC(legal, cand);
    if (c !== null) tierC.push({ candidate: cand, tier: 'C', score: c });
  }

  if (tierC.length === 0) return { verdict: 'no_match_after_ch_search', top5 };

  const picked = pickByLocality(tierC, row.hmrc_town_city, row.hmrc_county);
  if (picked === 'tied')
    return {
      verdict: 'requires_human_review_ch',
      contenders: tierC.slice(0, 5),
      top5,
    };
  return { verdict: 'verified_via_ch_search', picked, top5 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

console.log('Phase 0b — resolve suspects via Companies House search');
console.log('────────────────────────────────────────────────────────');

console.log('1/4 sanity-checking + extending staging table schema…');

const tableExists = (await sql`
  SELECT 1 FROM information_schema.tables
  WHERE table_name = 'hmrc_company_mapping_audit_phase0a'
`) as { '?column?': number }[];
if (tableExists.length === 0) {
  throw new Error(
    'Staging table hmrc_company_mapping_audit_phase0a not found. Run Phase 0a first.',
  );
}

await sql`
  ALTER TABLE hmrc_company_mapping_audit_phase0a
    ADD COLUMN IF NOT EXISTS ch_search_query_used   text,
    ADD COLUMN IF NOT EXISTS ch_search_results_top5 jsonb,
    ADD COLUMN IF NOT EXISTS phase0b_processed_at   timestamp
`;

console.log('2/4 selecting rows to process…');
const rows = (await sql`
  SELECT
    a.organisation_name,
    a.current_company_number,
    a.current_ch_name,
    a.parsed_legal_name,
    hsw.town_city  AS hmrc_town_city,
    hsw.county     AS hmrc_county
  FROM hmrc_company_mapping_audit_phase0a a
  LEFT JOIN LATERAL (
    SELECT town_city, county FROM hmrc_skilled_workers
    WHERE organisation_name = a.organisation_name
    LIMIT 1
  ) hsw ON true
  WHERE a.verdict = 'suspect_no_local_alternative'
  ORDER BY a.organisation_name
`) as SuspectRow[];

console.log(`    ${rows.length.toLocaleString()} rows to process`);
if (rows.length === 0) {
  console.log(
    'Nothing to do. Either Phase 0b has already completed, or Phase 0a found no suspects.',
  );
  process.exit(0);
}

console.log(
  '3/4 processing (cached responses skip the API; fresh queries hit ~1.8 req/sec)…',
);

const startTime = Date.now();
const counts = {
  verified_via_ch_search: 0,
  no_match_after_ch_search: 0,
  requires_human_review_ch: 0,
  errors: 0,
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

let processed = 0;
for (const row of rows) {
  let outcome: ProcessOutcome;
  try {
    outcome = await processRow(row);
  } catch (err) {
    counts.errors++;
    processed++;
    console.error(
      `  error processing "${row.organisation_name}": ${(err as Error).message}`,
    );
    continue;
  }

  const top5Json = JSON.stringify(outcome.top5);
  const queryUsed =
    row.parsed_legal_name || parseLegalCandidate(row.organisation_name);

  if (outcome.verdict === 'verified_via_ch_search') {
    const p = outcome.picked;
    await sql`
      UPDATE hmrc_company_mapping_audit_phase0a
      SET verdict                 = 'verified_via_ch_search',
          proposed_company_number = ${p.candidate.company_number},
          proposed_ch_name        = ${p.candidate.company_name},
          proposed_ch_status      = ${p.candidate.company_status},
          proposed_match_method   = ${
            p.tier === 'A'
              ? 'exact'
              : p.tier === 'B'
                ? 'previous_name'
                : 'token_sim'
          },
          proposed_match_score    = ${p.score},
          ch_search_query_used    = ${queryUsed},
          ch_search_results_top5  = ${top5Json}::jsonb,
          phase0b_processed_at    = now()
      WHERE organisation_name = ${row.organisation_name}
    `;
    counts.verified_via_ch_search++;
  } else if (outcome.verdict === 'no_match_after_ch_search') {
    await sql`
      UPDATE hmrc_company_mapping_audit_phase0a
      SET verdict                 = 'no_match_after_ch_search',
          proposed_company_number = NULL,
          proposed_ch_name        = NULL,
          proposed_ch_status      = NULL,
          proposed_match_method   = NULL,
          proposed_match_score    = NULL,
          ch_search_query_used    = ${queryUsed},
          ch_search_results_top5  = ${top5Json}::jsonb,
          phase0b_processed_at    = now()
      WHERE organisation_name = ${row.organisation_name}
    `;
    counts.no_match_after_ch_search++;
  } else {
    const contendersJson = JSON.stringify(
      outcome.contenders.map((c) => ({
        company_number: c.candidate.company_number,
        company_name: c.candidate.company_name,
        status: c.candidate.company_status,
        tier: c.tier,
        score: c.score,
      })),
    );
    await sql`
      UPDATE hmrc_company_mapping_audit_phase0a
      SET verdict                 = 'requires_human_review_ch',
          proposed_company_number = NULL,
          proposed_ch_name        = NULL,
          proposed_ch_status      = NULL,
          proposed_match_method   = NULL,
          proposed_match_score    = NULL,
          ch_search_query_used    = ${queryUsed},
          ch_search_results_top5  = ${top5Json}::jsonb,
          local_alternatives      = ${contendersJson}::jsonb,
          phase0b_processed_at    = now()
      WHERE organisation_name = ${row.organisation_name}
    `;
    counts.requires_human_review_ch++;
  }

  processed++;
  if (processed % PROGRESS_EVERY === 0 || processed === rows.length) {
    const elapsed = Date.now() - startTime;
    const rate = processed / (elapsed / 1000);
    const remaining = rows.length - processed;
    const etaMs = (remaining / rate) * 1000;
    process.stdout.write(
      `\r    ${processed.toLocaleString()}/${rows.length.toLocaleString()} ` +
        `| verified=${counts.verified_via_ch_search.toLocaleString()} ` +
        `no_match=${counts.no_match_after_ch_search.toLocaleString()} ` +
        `review=${counts.requires_human_review_ch.toLocaleString()} ` +
        `err=${counts.errors} ` +
        `| ${rate.toFixed(2)}/s | api=${apiCallsMade.toLocaleString()} ` +
        `| ETA ${formatDuration(etaMs)}        `,
    );
  }

  if (processed % INTERIM_SUMMARY_EVERY === 0 && processed !== rows.length) {
    const elapsed = Date.now() - startTime;
    const rate = processed / (elapsed / 1000);
    const remaining = rows.length - processed;
    const etaMs = (remaining / rate) * 1000;
    const cacheHitPct =
      processed > 0
        ? (((processed - apiCallsMade) / processed) * 100).toFixed(1)
        : '0.0';
    const summaryPct = (n: number) =>
      `(${((n / processed) * 100).toFixed(1).padStart(4)}%)`;
    const summaryPad = (n: number) => n.toLocaleString().padStart(7);

    process.stdout.write('\n');
    console.log(
      '\n  ┌──────────────────────────────────────────────────────────────────',
    );
    console.log(
      `  │ Interim summary @ ${processed.toLocaleString()}/${rows.length.toLocaleString()} (${((processed / rows.length) * 100).toFixed(1)}%)`,
    );
    console.log(
      '  ├──────────────────────────────────────────────────────────────────',
    );
    console.log(
      `  │   verified_via_ch_search    ${summaryPad(counts.verified_via_ch_search)} ${summaryPct(counts.verified_via_ch_search)}`,
    );
    console.log(
      `  │   no_match_after_ch_search  ${summaryPad(counts.no_match_after_ch_search)} ${summaryPct(counts.no_match_after_ch_search)}`,
    );
    console.log(
      `  │   requires_human_review_ch  ${summaryPad(counts.requires_human_review_ch)} ${summaryPct(counts.requires_human_review_ch)}`,
    );
    if (counts.errors > 0)
      console.log(
        `  │   errors                    ${summaryPad(counts.errors)} ${summaryPct(counts.errors)}`,
      );
    console.log(
      `  │   elapsed: ${formatDuration(elapsed)}  |  rate: ${rate.toFixed(2)}/s  |  ETA: ${formatDuration(etaMs)}`,
    );
    console.log(
      `  │   api calls: ${apiCallsMade.toLocaleString()}  |  cache hit rate: ${cacheHitPct}%`,
    );
    console.log(
      '  └──────────────────────────────────────────────────────────────────\n',
    );
  }
}
process.stdout.write('\n');

console.log('4/4 final summary');

const elapsed = Date.now() - startTime;
const total = rows.length;
const pct = (n: number) => `(${((n / total) * 100).toFixed(1).padStart(4)}%)`;
const pad = (n: number) => n.toLocaleString().padStart(8);

console.log(
  '═════════════════════════════════════════════════════════════════',
);
console.log(
  `Phase 0b complete. Resolved ${total.toLocaleString()} suspects in ${formatDuration(elapsed)}.`,
);
console.log(
  `API calls made: ${apiCallsMade.toLocaleString()} (cache hits skip these)`,
);
console.log(
  '═════════════════════════════════════════════════════════════════',
);
console.log(
  '\nFinal verdict transitions for the suspect_no_local_alternative bucket',
);
console.log(
  '─────────────────────────────────────────────────────────────────────',
);
console.log(
  `  verified_via_ch_search          ${pad(counts.verified_via_ch_search)} ${pct(counts.verified_via_ch_search)}`,
);
console.log(
  `  no_match_after_ch_search        ${pad(counts.no_match_after_ch_search)} ${pct(counts.no_match_after_ch_search)}`,
);
console.log(
  `  requires_human_review_ch        ${pad(counts.requires_human_review_ch)} ${pct(counts.requires_human_review_ch)}`,
);
if (counts.errors > 0)
  console.log(
    `  errors (left as suspect_no_local_alternative) ${pad(counts.errors)} ${pct(counts.errors)}`,
  );

const overall = (await sql`
  SELECT verdict, COUNT(*)::int FROM hmrc_company_mapping_audit_phase0a
  GROUP BY verdict ORDER BY COUNT(*) DESC
`) as { verdict: string; count: number }[];
console.log('\nOverall staging table state (after Phase 0a + 0b):');
console.table(overall);

console.log('\nDone.');
