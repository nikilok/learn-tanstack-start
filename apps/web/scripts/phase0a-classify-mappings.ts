/**
 * Phase 0a — local-only HMRC↔CH mapping classifier (zero CH API calls).
 *
 * Reads existing rows from hmrc_company_mapping and classifies each one
 * against locally-cached CH data using the verification rules from
 * docs/hmrc-ch-mapping-fix.md. Writes results to a staging table named
 * `hmrc_company_mapping_audit_phase0a`. No live tables are mutated.
 *
 * Run locally with:  bun scripts/phase0a-classify-mappings.ts
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@ss/db/client';
import dotenv from 'dotenv';
import {
  type CHCandidate,
  type MatchMethod,
  matchTierA,
  matchTierB,
  matchTierC,
  normaliseForComparison,
  parseHmrcName,
  TIER_C_THRESHOLD,
} from '../src/lib/hmrc-ch/pipeline';

// .env.local lives at the monorepo root, not under apps/web — resolve relative
// to this script's location so the run works from any cwd.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(SCRIPT_DIR, '../../../.env.local');
dotenv.config({ path: ROOT_ENV });

if (!process.env.POSTGRES_URL) {
  throw new Error(`POSTGRES_URL not found in ${ROOT_ENV}`);
}

const sql = neon(process.env.POSTGRES_URL as string);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INSERT_BATCH_SIZE = 500;
const CSV_SAMPLE_SIZE = 50;

const TRADING_AS_IN_PREV_REGEX = /(TRADING\s+AS|T\/A|D\/B\/A)/i;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type CHProfile = CHCandidate;

type Verdict =
  | 'verified_locally'
  | 'public_body_skip'
  | 'suspect_with_local_alternative'
  | 'requires_human_review'
  | 'suspect_no_local_alternative';

type ProposedRow = {
  organisation_name: string;
  current_company_number: string;
  current_ch_name: string | null;
  current_ch_status: string | null;
  proposed_company_number: string | null;
  proposed_ch_name: string | null;
  proposed_ch_status: string | null;
  proposed_match_method: MatchMethod;
  proposed_match_score: number | null;
  verdict: Verdict;
  parsed_legal_name: string;
  parsed_trading_name: string | null;
  matched_via_candidate: string | null;
  local_alternatives:
    | { company_number: string; company_name: string; status: string | null }[]
    | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Local CH index (built once, queried per row)
// ─────────────────────────────────────────────────────────────────────────────

type CHIndex = {
  byName: Map<string, CHProfile[]>; // UPPER(name) → profiles
  byPrevName: Map<string, CHProfile[]>; // UPPER(prev_name) → profiles (excluding TRADING AS entries)
};

/** Builds in-memory indexes over companies_house_profiles for O(1) name lookups. */
function buildCHIndex(profiles: CHProfile[]): CHIndex {
  const byName = new Map<string, CHProfile[]>();
  const byPrevName = new Map<string, CHProfile[]>();
  for (const p of profiles) {
    const k = normaliseForComparison(p.company_name);
    const existing = byName.get(k);
    if (existing) existing.push(p);
    else byName.set(k, [p]);

    if (p.previous_company_names) {
      for (const prev of p.previous_company_names) {
        if (TRADING_AS_IN_PREV_REGEX.test(prev)) continue;
        const pk = normaliseForComparison(prev);
        const ex = byPrevName.get(pk);
        if (ex) ex.push(p);
        else byPrevName.set(pk, [p]);
      }
    }
  }
  return { byName, byPrevName };
}

/**
 * Finds CH profiles in the local index that would pass Tier A or Tier B for the
 * legal candidate. Trading-name candidates are deliberately excluded — they
 * resolve to brand owners (e.g. SUBWAY LIMITED, PEPE'S PIRI PIRI LIMITED), not
 * the franchisee's actual legal entity. Excludes the current mapping itself.
 */
function findLocalAlternatives(
  legalCandidate: string,
  excludeCompanyNumber: string,
  index: CHIndex,
): {
  profile: CHProfile;
  method: 'local_replacement_exact' | 'local_replacement_previous_name';
}[] {
  const out: {
    profile: CHProfile;
    method: 'local_replacement_exact' | 'local_replacement_previous_name';
  }[] = [];
  const seen = new Set<string>();
  const key = normaliseForComparison(legalCandidate);

  const exactHits = index.byName.get(key) ?? [];
  for (const p of exactHits) {
    if (p.company_number === excludeCompanyNumber) continue;
    if (seen.has(p.company_number)) continue;
    seen.add(p.company_number);
    out.push({ profile: p, method: 'local_replacement_exact' });
  }

  const prevHits = index.byPrevName.get(key) ?? [];
  for (const p of prevHits) {
    if (p.company_number === excludeCompanyNumber) continue;
    if (seen.has(p.company_number)) continue;
    seen.add(p.company_number);
    out.push({ profile: p, method: 'local_replacement_previous_name' });
  }

  return out;
}

/** Picks the best alternative by locality match against the HMRC sponsor's town/county. Returns 'tied' if no unique winner. */
function pickByLocality(
  alternatives: { profile: CHProfile; method: MatchMethod }[],
  hmrcTown: string | null,
  hmrcCounty: string | null,
): { profile: CHProfile; method: MatchMethod } | 'tied' {
  if (alternatives.length === 1) return alternatives[0];
  if (!hmrcTown && !hmrcCounty) return 'tied';

  const hmrcTownU = hmrcTown?.toUpperCase() ?? '';
  const hmrcCountyU = hmrcCounty?.toUpperCase() ?? '';

  const scored = alternatives.map((a) => {
    const locU = (a.profile.locality ?? '').toUpperCase();
    const regU = (a.profile.region ?? '').toUpperCase();
    let score = 0;
    if (hmrcTownU && (locU === hmrcTownU || regU === hmrcTownU)) score += 2;
    if (hmrcCountyU && (locU === hmrcCountyU || regU === hmrcCountyU))
      score += 1;
    return { ...a, score };
  });

  const max = Math.max(...scored.map((s) => s.score));
  if (max === 0) return 'tied';
  const winners = scored.filter((s) => s.score === max);
  if (winners.length !== 1) return 'tied';
  return { profile: winners[0].profile, method: winners[0].method };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-row classification
// ─────────────────────────────────────────────────────────────────────────────

type MappingRow = {
  organisation_name: string;
  current_company_number: string;
  current_ch_name: string;
  current_ch_status: string | null;
  current_ch_previous_names: string[] | null;
  hmrc_town_city: string | null;
  hmrc_county: string | null;
};

/** Runs the full Phase-0a verification pipeline for a single mapping. */
function classifyOne(row: MappingRow, index: CHIndex): ProposedRow {
  const parsed = parseHmrcName(row.organisation_name);

  const base: Pick<
    ProposedRow,
    | 'organisation_name'
    | 'current_company_number'
    | 'current_ch_name'
    | 'current_ch_status'
    | 'parsed_legal_name'
    | 'parsed_trading_name'
  > = {
    organisation_name: row.organisation_name,
    current_company_number: row.current_company_number,
    current_ch_name: row.current_ch_name,
    current_ch_status: row.current_ch_status,
    parsed_legal_name: parsed.parsedLegal,
    parsed_trading_name: parsed.parsedTrading,
  };

  if (parsed.isPublicBody) {
    return {
      ...base,
      proposed_company_number: null,
      proposed_ch_name: null,
      proposed_ch_status: null,
      proposed_match_method: 'public_body',
      proposed_match_score: null,
      verdict: 'public_body_skip',
      matched_via_candidate: null,
      local_alternatives: null,
    };
  }

  const currentCh: CHProfile = {
    company_number: row.current_company_number,
    company_name: row.current_ch_name,
    company_status: row.current_ch_status,
    previous_company_names: row.current_ch_previous_names,
    locality: null,
    region: null,
  };

  // Verify the current mapping against the LEGAL candidate ONLY. Iterating
  // parsed.candidates (which includes the trading candidate) would let
  // franchisee-to-brand-owner mappings pass via Tier A on the trading name —
  // the same class of bug the legal-only restriction in findLocalAlternatives
  // closes. See docs/hmrc-ch-mapping-fix.md "Local-replacement policy: legal-only".
  {
    const candidate = parsed.parsedLegal;
    const a = matchTierA(candidate, currentCh);
    if (a !== null) {
      return {
        ...base,
        proposed_company_number: row.current_company_number,
        proposed_ch_name: row.current_ch_name,
        proposed_ch_status: row.current_ch_status,
        proposed_match_method: 'exact',
        proposed_match_score: a,
        verdict: 'verified_locally',
        matched_via_candidate: candidate,
        local_alternatives: null,
      };
    }
    const b = matchTierB(candidate, currentCh);
    if (b !== null) {
      return {
        ...base,
        proposed_company_number: row.current_company_number,
        proposed_ch_name: row.current_ch_name,
        proposed_ch_status: row.current_ch_status,
        proposed_match_method: 'previous_name',
        proposed_match_score: b,
        verdict: 'verified_locally',
        matched_via_candidate: candidate,
        local_alternatives: null,
      };
    }
    const c = matchTierC(candidate, currentCh);
    if (c !== null) {
      return {
        ...base,
        proposed_company_number: row.current_company_number,
        proposed_ch_name: row.current_ch_name,
        proposed_ch_status: row.current_ch_status,
        proposed_match_method: 'token_sim',
        proposed_match_score: c,
        verdict: 'verified_locally',
        matched_via_candidate: candidate,
        local_alternatives: null,
      };
    }
  }

  const alternatives = findLocalAlternatives(
    parsed.parsedLegal,
    row.current_company_number,
    index,
  );

  if (alternatives.length === 0) {
    return {
      ...base,
      proposed_company_number: null,
      proposed_ch_name: null,
      proposed_ch_status: null,
      proposed_match_method: null,
      proposed_match_score: null,
      verdict: 'suspect_no_local_alternative',
      matched_via_candidate: null,
      local_alternatives: null,
    };
  }

  if (alternatives.length === 1) {
    const winner = alternatives[0];
    return {
      ...base,
      proposed_company_number: winner.profile.company_number,
      proposed_ch_name: winner.profile.company_name,
      proposed_ch_status: winner.profile.company_status,
      proposed_match_method: winner.method,
      proposed_match_score:
        winner.method === 'local_replacement_exact' ? 1.0 : 0.95,
      verdict: 'suspect_with_local_alternative',
      matched_via_candidate: null,
      local_alternatives: null,
    };
  }

  // If any exact-name local replacement exists, restrict the tiebreak pool to
  // those — a previous-name alternative in the right town must never beat an
  // exact legal-name match elsewhere. (Same score-before-locality discipline
  // pickByLocality enforces in src/lib/hmrc-ch/pipeline.ts.)
  const rankedAlternatives = alternatives.some(
    (a) => a.method === 'local_replacement_exact',
  )
    ? alternatives.filter((a) => a.method === 'local_replacement_exact')
    : alternatives;

  const picked = pickByLocality(
    rankedAlternatives.map((a) => ({
      profile: a.profile,
      method: a.method as MatchMethod,
    })),
    row.hmrc_town_city,
    row.hmrc_county,
  );

  if (picked === 'tied') {
    return {
      ...base,
      proposed_company_number: null,
      proposed_ch_name: null,
      proposed_ch_status: null,
      proposed_match_method: null,
      proposed_match_score: null,
      verdict: 'requires_human_review',
      matched_via_candidate: null,
      local_alternatives: alternatives.slice(0, 5).map((a) => ({
        company_number: a.profile.company_number,
        company_name: a.profile.company_name,
        status: a.profile.company_status,
      })),
    };
  }

  return {
    ...base,
    proposed_company_number: picked.profile.company_number,
    proposed_ch_name: picked.profile.company_name,
    proposed_ch_status: picked.profile.company_status,
    proposed_match_method: picked.method,
    proposed_match_score:
      picked.method === 'local_replacement_exact' ? 1.0 : 0.95,
    verdict: 'suspect_with_local_alternative',
    matched_via_candidate: null,
    local_alternatives: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const startTime = Date.now();

console.log('Phase 0a — local-only HMRC↔CH mapping classifier');
console.log('────────────────────────────────────────────────────');

console.log('1/5 dropping & recreating staging table…');
await sql`DROP TABLE IF EXISTS hmrc_company_mapping_audit_phase0a`;
await sql`
  CREATE TABLE hmrc_company_mapping_audit_phase0a (
    organisation_name        text PRIMARY KEY,
    current_company_number   varchar(20),
    current_ch_name          varchar(255),
    current_ch_status        varchar(50),
    proposed_company_number  varchar(20),
    proposed_ch_name         varchar(255),
    proposed_ch_status       varchar(50),
    proposed_match_method    varchar(40),
    proposed_match_score     numeric(4,3),
    verdict                  varchar(40) NOT NULL,
    parsed_legal_name        text,
    parsed_trading_name      text,
    matched_via_candidate    text,
    local_alternatives       jsonb,
    classified_at            timestamp DEFAULT now()
  )
`;

console.log('2/5 loading all CH profiles into in-memory index…');
const profiles = (await sql`
  SELECT company_number, company_name, company_status,
         previous_company_names, locality, region
  FROM companies_house_profiles
`) as CHProfile[];
console.log(`    loaded ${profiles.length.toLocaleString()} profiles`);
const index = buildCHIndex(profiles);
console.log(
  `    built indexes: ${index.byName.size.toLocaleString()} unique names, ${index.byPrevName.size.toLocaleString()} unique previous names`,
);

console.log(
  '3/5 reading mappings joined to current CH profile + HMRC locality…',
);
const rows = (await sql`
  SELECT
    m.organisation_name                          AS organisation_name,
    m.company_number                             AS current_company_number,
    chp.company_name                             AS current_ch_name,
    chp.company_status                           AS current_ch_status,
    chp.previous_company_names                   AS current_ch_previous_names,
    hsw.town_city                                AS hmrc_town_city,
    hsw.county                                   AS hmrc_county
  FROM hmrc_company_mapping m
  JOIN companies_house_profiles chp ON chp.company_number = m.company_number
  LEFT JOIN LATERAL (
    SELECT town_city, county FROM hmrc_skilled_workers
    WHERE organisation_name = m.organisation_name
    LIMIT 1
  ) hsw ON true
`) as MappingRow[];
console.log(`    ${rows.length.toLocaleString()} mappings to classify`);

console.log('4/5 classifying & buffering inserts…');
const proposed: ProposedRow[] = [];
for (const row of rows) proposed.push(classifyOne(row, index));

let inserted = 0;
for (let i = 0; i < proposed.length; i += INSERT_BATCH_SIZE) {
  const batch = proposed.slice(i, i + INSERT_BATCH_SIZE);
  const values = batch.map((p) => [
    p.organisation_name,
    p.current_company_number,
    p.current_ch_name,
    p.current_ch_status,
    p.proposed_company_number,
    p.proposed_ch_name,
    p.proposed_ch_status,
    p.proposed_match_method,
    p.proposed_match_score,
    p.verdict,
    p.parsed_legal_name,
    p.parsed_trading_name,
    p.matched_via_candidate,
    p.local_alternatives ? JSON.stringify(p.local_alternatives) : null,
  ]);
  await sql`
    INSERT INTO hmrc_company_mapping_audit_phase0a (
      organisation_name, current_company_number, current_ch_name, current_ch_status,
      proposed_company_number, proposed_ch_name, proposed_ch_status,
      proposed_match_method, proposed_match_score, verdict,
      parsed_legal_name, parsed_trading_name, matched_via_candidate, local_alternatives
    )
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(
      values.map((v) => ({
        organisation_name: v[0],
        current_company_number: v[1],
        current_ch_name: v[2],
        current_ch_status: v[3],
        proposed_company_number: v[4],
        proposed_ch_name: v[5],
        proposed_ch_status: v[6],
        proposed_match_method: v[7],
        proposed_match_score: v[8],
        verdict: v[9],
        parsed_legal_name: v[10],
        parsed_trading_name: v[11],
        matched_via_candidate: v[12],
        local_alternatives: v[13] ? JSON.parse(v[13] as string) : null,
      })),
    )}::jsonb)
    AS x(
      organisation_name text, current_company_number varchar(20),
      current_ch_name varchar(255), current_ch_status varchar(50),
      proposed_company_number varchar(20), proposed_ch_name varchar(255),
      proposed_ch_status varchar(50), proposed_match_method varchar(40),
      proposed_match_score numeric(4,3), verdict varchar(40),
      parsed_legal_name text, parsed_trading_name text,
      matched_via_candidate text, local_alternatives jsonb
    )
  `;
  inserted += batch.length;
  if (inserted % 5000 === 0 || inserted === proposed.length) {
    process.stdout.write(
      `    inserted ${inserted.toLocaleString()}/${proposed.length.toLocaleString()}\r`,
    );
  }
}
process.stdout.write('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('5/5 generating summary + CSV samples…\n');

const verdictCounts: Record<Verdict, number> = {
  verified_locally: 0,
  public_body_skip: 0,
  suspect_with_local_alternative: 0,
  requires_human_review: 0,
  suspect_no_local_alternative: 0,
};
const tierCounts = { exact: 0, previous_name: 0, token_sim: 0 };
const tierCBuckets = { '0.85-0.89': 0, '0.90-0.94': 0, '0.95-0.99': 0 };

for (const p of proposed) {
  verdictCounts[p.verdict]++;
  if (p.verdict === 'verified_locally' && p.proposed_match_method) {
    if (p.proposed_match_method === 'exact') tierCounts.exact++;
    else if (p.proposed_match_method === 'previous_name')
      tierCounts.previous_name++;
    else if (p.proposed_match_method === 'token_sim') {
      tierCounts.token_sim++;
      const s = p.proposed_match_score ?? 0;
      if (s < 0.9) tierCBuckets['0.85-0.89']++;
      else if (s < 0.95) tierCBuckets['0.90-0.94']++;
      else tierCBuckets['0.95-0.99']++;
    }
  }
}

const total = proposed.length;
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

const pad = (n: number) => n.toLocaleString().padStart(8);
const pct = (n: number) => `(${((n / total) * 100).toFixed(1).padStart(4)}%)`;

console.log(
  '═════════════════════════════════════════════════════════════════',
);
console.log(
  `Phase 0a complete. Classified ${total.toLocaleString()} mappings in ${elapsed}s.`,
);
console.log(
  '═════════════════════════════════════════════════════════════════',
);
console.log('\nVerdict breakdown');
console.log(
  '─────────────────────────────────────────────────────────────────',
);
console.log(
  `  verified_locally                 ${pad(verdictCounts.verified_locally)} ${pct(verdictCounts.verified_locally)}  ← no action needed`,
);
console.log(
  `  suspect_with_local_alternative   ${pad(verdictCounts.suspect_with_local_alternative)} ${pct(verdictCounts.suspect_with_local_alternative)}  ← Phase 1 swap candidates`,
);
console.log(
  `  public_body_skip                 ${pad(verdictCounts.public_body_skip)} ${pct(verdictCounts.public_body_skip)}  ← Phase 2 candidates`,
);
console.log(
  `  requires_human_review            ${pad(verdictCounts.requires_human_review)} ${pct(verdictCounts.requires_human_review)}  ← eyeball before acting`,
);
console.log(
  `  suspect_no_local_alternative     ${pad(verdictCounts.suspect_no_local_alternative)} ${pct(verdictCounts.suspect_no_local_alternative)}  ← Phase 0b will hit CH`,
);

console.log('\nTier hits within verified_locally');
console.log(
  '─────────────────────────────────────────────────────────────────',
);
console.log(`  Tier A (exact name)              ${pad(tierCounts.exact)}`);
console.log(
  `  Tier B (clean previous-name)     ${pad(tierCounts.previous_name)}`,
);
console.log(
  `  Tier C (token sim ≥ ${TIER_C_THRESHOLD})         ${pad(tierCounts.token_sim)}`,
);

if (tierCounts.token_sim > 0) {
  const maxBucket = Math.max(...Object.values(tierCBuckets));
  const bar = (n: number) =>
    '█'.repeat(Math.round((n / maxBucket) * 10)).padEnd(10, '░');
  console.log('\nToken-similarity histogram (Tier C only)');
  console.log(
    '─────────────────────────────────────────────────────────────────',
  );
  console.log(
    `  0.85–0.89  ${bar(tierCBuckets['0.85-0.89'])}  ${pad(tierCBuckets['0.85-0.89'])}`,
  );
  console.log(
    `  0.90–0.94  ${bar(tierCBuckets['0.90-0.94'])}  ${pad(tierCBuckets['0.90-0.94'])}`,
  );
  console.log(
    `  0.95–0.99  ${bar(tierCBuckets['0.95-0.99'])}  ${pad(tierCBuckets['0.95-0.99'])}`,
  );
}

const residual = verdictCounts.suspect_no_local_alternative;
const wallTime2 = Math.ceil(residual / 2 / 60); // mins @ 2 req/sec
const wallTime4 = Math.ceil(residual / 4 / 60); // mins @ 4 req/sec
console.log('\nPhase 0b projection');
console.log(
  '─────────────────────────────────────────────────────────────────',
);
console.log(`  CH search calls needed:          ${pad(residual)}`);
console.log(
  `  Wall time @ 2 req/sec (1 key):   ${String(Math.floor(wallTime2 / 60)).padStart(3)}h ${String(wallTime2 % 60).padStart(2, '0')}m`,
);
console.log(
  `  Wall time @ 4 req/sec (2 keys):  ${String(Math.floor(wallTime4 / 60)).padStart(3)}h ${String(wallTime4 % 60).padStart(2, '0')}m`,
);

// ─────────────────────────────────────────────────────────────────────────────
// CSV samples
// ─────────────────────────────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsvSample(verdict: Verdict, sampleSize: number | 'all') {
  const rows = proposed.filter((p) => p.verdict === verdict);
  if (rows.length === 0) return;
  const sample =
    sampleSize === 'all' || rows.length <= sampleSize
      ? rows
      : [...rows].sort(() => Math.random() - 0.5).slice(0, sampleSize);

  const header = [
    'organisation_name',
    'current_company_number',
    'current_ch_name',
    'current_ch_status',
    'proposed_company_number',
    'proposed_ch_name',
    'proposed_ch_status',
    'proposed_match_method',
    'proposed_match_score',
    'parsed_legal_name',
    'parsed_trading_name',
    'matched_via_candidate',
    'local_alternatives',
    'ch_url',
  ];

  const lines = [header.join(',')];
  for (const p of sample) {
    lines.push(
      [
        p.organisation_name,
        p.current_company_number,
        p.current_ch_name,
        p.current_ch_status,
        p.proposed_company_number,
        p.proposed_ch_name,
        p.proposed_ch_status,
        p.proposed_match_method,
        p.proposed_match_score,
        p.parsed_legal_name,
        p.parsed_trading_name,
        p.matched_via_candidate,
        p.local_alternatives,
        p.proposed_company_number
          ? `https://find-and-update.company-information.service.gov.uk/company/${p.proposed_company_number}`
          : '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  const path = join(tmpdir(), `phase0a_${verdict}.csv`);
  writeFileSync(path, lines.join('\n'));
  console.log(`  wrote ${path} (${sample.length.toLocaleString()} rows)`);
}

console.log('\nSample CSV files');
console.log(
  '─────────────────────────────────────────────────────────────────',
);
writeCsvSample('verified_locally', CSV_SAMPLE_SIZE);
writeCsvSample('suspect_with_local_alternative', CSV_SAMPLE_SIZE);
writeCsvSample('public_body_skip', 'all');
writeCsvSample('requires_human_review', 'all');
writeCsvSample('suspect_no_local_alternative', CSV_SAMPLE_SIZE);

console.log('\nDone.');
