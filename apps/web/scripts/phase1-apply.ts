/**
 * Phase 1 — apply Phase 0a + 0b corrections to the live `hmrc_company_mapping`
 * table. Every change is mirrored to `hmrc_company_mapping_audit` for revertibility.
 *
 * Reads from `hmrc_company_mapping_audit_phase0a` (the staging table populated
 * by Phase 0a + Phase 0b) and writes one of these UPDATEs per row:
 *
 *   verified_locally / verified_via_ch_search / suspect_with_local_alternative
 *     → swap company_number (if changed) + write provenance
 *   public_body_skip
 *     → NULL company_number + is_public_body=true + match_method='public_body'
 *   no_match_after_ch_search
 *     → NULL company_number + match_method='no_match'
 *   requires_human_review_ch
 *     → SKIP (leave production mapping unchanged for manual review)
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/phase1-apply.ts --dry-run
 *   bun apps/web/scripts/phase1-apply.ts --apply-verdict=suspect_with_local_alternative,public_body_skip
 *   bun apps/web/scripts/phase1-apply.ts                    # apply everything
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@ss/db/client';
import dotenv from 'dotenv';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(SCRIPT_DIR, '../../../.env.local');
dotenv.config({ path: ROOT_ENV });
if (!process.env.POSTGRES_URL)
  throw new Error(`POSTGRES_URL not in ${ROOT_ENV}`);

const sql = neon(process.env.POSTGRES_URL);

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const verdictArg = args.find((a) => a.startsWith('--apply-verdict='));
const APPLY_VERDICTS = verdictArg
  ? new Set(verdictArg.replace('--apply-verdict=', '').split(','))
  : null;

const SUPPORTED_VERDICTS = [
  'verified_locally',
  'verified_via_ch_search',
  'suspect_with_local_alternative',
  'public_body_skip',
  'no_match_after_ch_search',
] as const;

const SKIPPED_VERDICTS = ['requires_human_review', 'requires_human_review_ch'];

const BATCH_SIZE = 500;
const CHANGED_BY = 'phase1_apply';

type Row = {
  organisation_name: string;
  current_company_number: string | null;
  proposed_company_number: string | null;
  proposed_match_method: string | null;
  proposed_match_score: string | null; // numeric comes back as string from neon
  matched_via_candidate: string | null;
  ch_search_query_used: string | null;
  verdict: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight checks
// ─────────────────────────────────────────────────────────────────────────────

async function preflight() {
  // 1. Staging table must exist
  const stagingExists = (await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'hmrc_company_mapping_audit_phase0a'
  `) as { '?column?': number }[];
  if (stagingExists.length === 0) {
    throw new Error(
      'Staging table hmrc_company_mapping_audit_phase0a not found. Run Phase 0a + 0b first.',
    );
  }

  // 2. Live table must have the new provenance columns (schema migration applied)
  const cols = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'hmrc_company_mapping'
  `) as { column_name: string }[];
  const colSet = new Set(cols.map((c) => c.column_name));
  const required = [
    'is_public_body',
    'match_method',
    'match_score',
    'query_used',
    'verified_at',
  ];
  const missing = required.filter((c) => !colSet.has(c));
  if (missing.length > 0) {
    throw new Error(
      `hmrc_company_mapping is missing the Phase 1 schema migration. Missing columns: ${missing.join(', ')}. Run \`bun db:generate\` then \`bun db:migrate\` first.`,
    );
  }

  // 3. Audit table must exist
  const auditExists = (await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'hmrc_company_mapping_audit'
  `) as { '?column?': number }[];
  if (auditExists.length === 0) {
    throw new Error(
      'Audit table hmrc_company_mapping_audit not found. Run the Phase 1 schema migration first.',
    );
  }

  // 4. Phase 0b must have completed (no rows still flagged suspect_no_local_alternative)
  const stillSuspect = (await sql`
    SELECT COUNT(*)::int FROM hmrc_company_mapping_audit_phase0a
    WHERE verdict = 'suspect_no_local_alternative'
  `) as { count: number }[];
  if (stillSuspect[0].count > 0) {
    throw new Error(
      `Phase 0b is incomplete — ${stillSuspect[0].count} rows are still 'suspect_no_local_alternative'. Run phase0b-resolve-suspects.ts to completion first.`,
    );
  }

  // 4. Live table must allow company_number to be NULL
  const numberCol = (await sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'hmrc_company_mapping' AND column_name = 'company_number'
  `) as { is_nullable: string }[];
  if (numberCol[0]?.is_nullable !== 'YES') {
    throw new Error(
      'company_number is still NOT NULL on hmrc_company_mapping. The Phase 1 migration must DROP NOT NULL.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → UPDATE planning
// ─────────────────────────────────────────────────────────────────────────────

type Plan =
  | {
      kind: 'verified';
      companyNumber: string;
      matchMethod: string;
      matchScore: string | null;
      queryUsed: string | null;
    }
  | { kind: 'public_body' }
  | { kind: 'no_match'; queryUsed: string | null }
  | { kind: 'skip' };

function plan(row: Row): Plan {
  if (
    row.verdict === 'verified_locally' ||
    row.verdict === 'verified_via_ch_search' ||
    row.verdict === 'suspect_with_local_alternative'
  ) {
    if (!row.proposed_company_number || !row.proposed_match_method) {
      return { kind: 'skip' };
    }
    return {
      kind: 'verified',
      companyNumber: row.proposed_company_number,
      matchMethod: row.proposed_match_method,
      matchScore: row.proposed_match_score,
      queryUsed: row.matched_via_candidate ?? row.ch_search_query_used,
    };
  }
  if (row.verdict === 'public_body_skip') return { kind: 'public_body' };
  if (row.verdict === 'no_match_after_ch_search')
    return { kind: 'no_match', queryUsed: row.ch_search_query_used };
  return { kind: 'skip' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

async function applyRow(row: Row, p: Plan) {
  const oldNumber = row.current_company_number;
  const old = (await sql`
    SELECT company_number, match_method FROM hmrc_company_mapping
    WHERE organisation_name = ${row.organisation_name}
  `) as { company_number: string | null; match_method: string | null }[];
  const oldMethod = old[0]?.match_method ?? null;
  const oldNumberLive = old[0]?.company_number ?? oldNumber;

  if (p.kind === 'skip') return { changed: false, was: 'no-op' };

  if (p.kind === 'verified') {
    // Idempotent: only write if something actually differs
    if (oldNumberLive === p.companyNumber && oldMethod === p.matchMethod)
      return { changed: false, was: 'unchanged' };
    await sql`
      UPDATE hmrc_company_mapping SET
        company_number = ${p.companyNumber},
        is_public_body = false,
        match_method   = ${p.matchMethod},
        match_score    = ${p.matchScore},
        query_used     = ${p.queryUsed},
        verified_at    = now()
      WHERE organisation_name = ${row.organisation_name}
    `;
    await sql`
      INSERT INTO hmrc_company_mapping_audit
        (organisation_name, old_company_number, new_company_number, old_match_method, new_match_method, changed_by)
      VALUES (${row.organisation_name}, ${oldNumberLive}, ${p.companyNumber}, ${oldMethod}, ${p.matchMethod}, ${CHANGED_BY})
    `;
    return {
      changed: true,
      was: oldNumberLive === p.companyNumber ? 'provenance_only' : 'swap',
    };
  }

  if (p.kind === 'public_body') {
    if (oldNumberLive === null && oldMethod === 'public_body')
      return { changed: false, was: 'unchanged' };
    await sql`
      UPDATE hmrc_company_mapping SET
        company_number = NULL,
        is_public_body = true,
        match_method   = 'public_body',
        match_score    = NULL,
        query_used     = NULL,
        verified_at    = now()
      WHERE organisation_name = ${row.organisation_name}
    `;
    await sql`
      INSERT INTO hmrc_company_mapping_audit
        (organisation_name, old_company_number, new_company_number, old_match_method, new_match_method, changed_by)
      VALUES (${row.organisation_name}, ${oldNumberLive}, NULL, ${oldMethod}, 'public_body', ${CHANGED_BY})
    `;
    return { changed: true, was: 'public_body' };
  }

  if (p.kind === 'no_match') {
    if (oldNumberLive === null && oldMethod === 'no_match')
      return { changed: false, was: 'unchanged' };
    await sql`
      UPDATE hmrc_company_mapping SET
        company_number = NULL,
        is_public_body = false,
        match_method   = 'no_match',
        match_score    = NULL,
        query_used     = ${p.queryUsed},
        verified_at    = now()
      WHERE organisation_name = ${row.organisation_name}
    `;
    await sql`
      INSERT INTO hmrc_company_mapping_audit
        (organisation_name, old_company_number, new_company_number, old_match_method, new_match_method, changed_by)
      VALUES (${row.organisation_name}, ${oldNumberLive}, NULL, ${oldMethod}, 'no_match', ${CHANGED_BY})
    `;
    return { changed: true, was: 'no_match' };
  }

  return { changed: false, was: 'unknown' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log('Phase 1 — apply staging-table corrections to live mapping');
console.log('───────────────────────────────────────────────────────────');
console.log(
  `  mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (will mutate hmrc_company_mapping)'}`,
);
console.log(
  `  apply-verdicts: ${APPLY_VERDICTS ? Array.from(APPLY_VERDICTS).join(',') : 'all supported'}`,
);
console.log('');

console.log('1/3 pre-flight checks…');
await preflight();
console.log('    OK');

console.log('2/3 selecting rows to apply…');
const rows = (await sql`
  SELECT
    organisation_name,
    current_company_number,
    proposed_company_number,
    proposed_match_method,
    proposed_match_score::text AS proposed_match_score,
    matched_via_candidate,
    ch_search_query_used,
    verdict
  FROM hmrc_company_mapping_audit_phase0a
  ORDER BY verdict, organisation_name
`) as Row[];

const toApply = rows.filter((r) => {
  if (SKIPPED_VERDICTS.includes(r.verdict)) return false;
  if (APPLY_VERDICTS && !APPLY_VERDICTS.has(r.verdict)) return false;
  return SUPPORTED_VERDICTS.includes(r.verdict as never);
});

console.log(
  `    ${rows.length.toLocaleString()} staging rows total · ${toApply.length.toLocaleString()} match the apply filter · ${(rows.length - toApply.length).toLocaleString()} skipped`,
);

console.log('3/3 planning + applying…');

const counts: Record<string, number> = {
  swap: 0,
  provenance_only: 0,
  public_body: 0,
  no_match: 0,
  unchanged: 0,
  'no-op': 0,
  unknown: 0,
};

let processed = 0;
for (const row of toApply) {
  const p = plan(row);
  if (DRY_RUN) {
    if (p.kind === 'verified') {
      const changed = row.current_company_number !== p.companyNumber;
      counts[changed ? 'swap' : 'provenance_only']++;
    } else if (p.kind === 'public_body') counts.public_body++;
    else if (p.kind === 'no_match') counts.no_match++;
    else counts.unchanged++;
  } else {
    const r = await applyRow(row, p);
    counts[r.was] = (counts[r.was] ?? 0) + 1;
  }
  processed++;
  if (processed % BATCH_SIZE === 0 || processed === toApply.length) {
    process.stdout.write(
      `\r    ${processed.toLocaleString()}/${toApply.length.toLocaleString()}        `,
    );
  }
}
process.stdout.write('\n');

console.log('\nSummary');
console.log('───────────────────────────────────────────────────────────');
const labels = {
  swap: 'company_number swapped',
  provenance_only: 'provenance backfilled (no swap)',
  public_body: 'NULLed + flagged is_public_body=true',
  no_match: 'NULLed + match_method=no_match',
  unchanged: 'already in target state (no-op)',
  'no-op': 'skipped (no plan)',
  unknown: 'unknown',
} as Record<string, string>;
for (const k of Object.keys(counts)) {
  if (counts[k] > 0)
    console.log(
      `  ${labels[k] ?? k}: ${counts[k].toLocaleString().padStart(8)}`,
    );
}

if (DRY_RUN) {
  console.log(
    '\nThis was a dry run. No live writes were made. Re-run without --dry-run to apply.',
  );
} else {
  const totalChanged = (await sql`
    SELECT COUNT(*)::int FROM hmrc_company_mapping_audit
    WHERE changed_by = ${CHANGED_BY}
  `) as { count: number }[];
  console.log(
    `\nAudit table now has ${totalChanged[0].count.toLocaleString()} rows attributed to '${CHANGED_BY}'.`,
  );
}
