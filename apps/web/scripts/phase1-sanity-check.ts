/**
 * Post-Phase-1 sanity check. Run anytime to verify the data correction is
 * holding and to detect drift / leak from the still-unfixed on-demand
 * resolver path (`getCompanyProfile`'s buggy else branch).
 *
 * Run from monorepo root:  bun apps/web/scripts/phase1-sanity-check.ts
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

// Cutoff: the date Phase 1 was applied. Anything modified after this is drift
// (ch-stream renames, on-demand resolver creating new mappings, manual fixes).
const PHASE1_APPLIED_DATE = '2026-04-27';

console.log('Phase 1 sanity check');
console.log(
  '═════════════════════════════════════════════════════════════════\n',
);

// 1. Total rows + breakdown by match_method (verifies Phase 1 provenance is intact)
console.log('1) hmrc_company_mapping breakdown by match_method');
const breakdown = await sql`
  SELECT
    COALESCE(match_method, 'NULL — never verified') AS method,
    is_public_body,
    COUNT(*)::int AS count,
    COUNT(*) FILTER (WHERE company_number IS NULL)::int AS nulled_company_number
  FROM hmrc_company_mapping
  GROUP BY match_method, is_public_body
  ORDER BY count DESC
`;
console.table(breakdown);

const totals = await sql`
  SELECT
    COUNT(*)::int AS total_mappings,
    COUNT(*) FILTER (WHERE company_number IS NULL)::int AS null_mappings,
    COUNT(*) FILTER (WHERE is_public_body = true)::int AS public_body_count,
    COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::int AS has_provenance
  FROM hmrc_company_mapping
`;
console.log('Totals:');
console.table(totals);

// 2. Audit-table consistency check
console.log('\n2) Audit table — phase1_apply attribution');
const auditCounts = await sql`
  SELECT changed_by, COUNT(*)::int FROM hmrc_company_mapping_audit
  GROUP BY changed_by ORDER BY COUNT(*) DESC
`;
console.table(auditCounts);
console.log(
  '  (Expect ~126,850 rows attributed to phase1_apply across the two Phase 1 runs.)',
);

// 3. Drift detection — rows modified after Phase 1 cutoff that aren't from phase1_apply
console.log(
  `\n3) Mappings modified since ${PHASE1_APPLIED_DATE} (drift / new activity)`,
);
const drift = await sql`
  SELECT
    COUNT(*)::int AS rows_modified_post_phase1
  FROM hmrc_company_mapping
  WHERE verified_at > ${PHASE1_APPLIED_DATE}::date + interval '1 day'
`;
console.table(drift);
console.log(
  '  Caveat: phase1_apply itself sets verified_at = now() so re-running it would inflate this.',
);
console.log('  Cross-reference with audit-table changed_at to distinguish.');

// 4. New mappings added since Phase 1 (Phase 3 leak proxy — new HMRC sponsors that came in via getCompanyProfile)
console.log(
  `\n4) New mappings created since ${PHASE1_APPLIED_DATE} (Phase 3 leak proxy)`,
);
const newMappings = await sql`
  WITH recent_audit AS (
    SELECT organisation_name, MIN(changed_at) AS first_seen
    FROM hmrc_company_mapping_audit
    GROUP BY organisation_name
  )
  SELECT
    COUNT(*) FILTER (WHERE m.organisation_name NOT IN (SELECT organisation_name FROM recent_audit))::int
      AS untracked_mappings,
    COUNT(*) FILTER (WHERE m.verified_at IS NULL)::int AS no_provenance
  FROM hmrc_company_mapping m
`;
console.table(newMappings);
console.log(
  '  Untracked rows = sponsors with no phase1_apply audit entry. Most likely created',
);
console.log(
  '  by getCompanyProfile or the seed since Phase 1 ran. Higher count = more urgent Phase 3.',
);

// Sample 10 such rows
const newSample = await sql`
  WITH audited AS (
    SELECT DISTINCT organisation_name FROM hmrc_company_mapping_audit
  )
  SELECT m.organisation_name, m.company_number, m.match_method, m.verified_at
  FROM hmrc_company_mapping m
  WHERE m.organisation_name NOT IN (SELECT organisation_name FROM audited)
  ORDER BY m.verified_at DESC NULLS LAST
  LIMIT 10
`;
if (newSample.length > 0) {
  console.log('\n  Sample of untracked mappings (oldest verified_at first):');
  console.table(newSample);
}

// 5. The 196 requires_human_review_ch — see if any were manually updated
console.log('\n5) requires_human_review_ch staging rows — any manual updates?');
const reviewStatus = await sql`
  SELECT
    a.verdict,
    COUNT(*)::int AS staging_count,
    COUNT(*) FILTER (WHERE m.match_method IS NOT NULL AND m.match_method != 'no_match')::int
      AS manually_resolved,
    COUNT(*) FILTER (WHERE m.company_number IS NOT NULL AND m.match_method IS NULL)::int
      AS unchanged_in_live
  FROM hmrc_company_mapping_audit_phase0a a
  JOIN hmrc_company_mapping m ON m.organisation_name = a.organisation_name
  WHERE a.verdict IN ('requires_human_review', 'requires_human_review_ch')
  GROUP BY a.verdict
`;
console.table(reviewStatus);
console.log(
  '  Expect: staging_count ≈ 198 (196 + 2), manually_resolved = 0 unless someone has been picking off rows.',
);

// 6. Top match_method distribution sanity (compare against expected from Phase 1 outcomes)
console.log(
  '\n6) Method distribution sanity (expected vs actual after both Phase 1 runs)',
);
console.log('  Expected:');
console.log(
  '    exact:               ~103k  (verified_locally Tier A + verified_via_ch_search exact)',
);
console.log('    previous_name:       ~2k');
console.log('    token_sim:           ~4k');
console.log('    no_match:            ~16k');
console.log('    public_body:         388');
console.log(
  '    NULL (unverified):   small (the 196 + 2 human review + any post-Phase-1 untracked rows)',
);

console.log('\nDone.');
