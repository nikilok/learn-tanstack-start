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

// 3. Drift detection — rows modified after the most recent phase1_apply audit
//    write. Anchored to the actual Phase 1 application time (not the calendar
//    date) so drift on the same day is caught. Falls back to epoch-zero if
//    phase1_apply has never run, so the query is safe in fresh environments.
console.log(
  `\n3) Mappings modified since the last phase1_apply audit entry (drift / new activity)`,
);
const drift = await sql`
  SELECT
    COUNT(*)::int AS rows_modified_post_phase1,
    (SELECT COALESCE(MAX(changed_at), '1970-01-01'::timestamp)
     FROM hmrc_company_mapping_audit
     WHERE changed_by = 'phase1_apply')::text
      AS phase1_cutoff_used
  FROM hmrc_company_mapping
  WHERE verified_at > (
    SELECT COALESCE(MAX(changed_at), '1970-01-01'::timestamp)
    FROM hmrc_company_mapping_audit
    WHERE changed_by = 'phase1_apply'
  )
`;
console.table(drift);
console.log(
  '  Cutoff is the most recent phase1_apply audit timestamp. Re-running phase1_apply',
);
console.log(
  '  will advance this cutoff, so this metric self-resets after each apply.',
);

// 4. New-mapping leak proxy (Phase 3) — sponsors in hmrc_company_mapping that
//    didn't exist in the staging snapshot AND weren't deliberately skipped as
//    human_review. Counts only genuinely-new rows from the on-demand resolver,
//    not the human_review skips that legitimately have NULL provenance.
console.log(
  `\n4) New mappings created since Phase 1 (Phase 3 leak proxy — strictly post-Phase-1 only)`,
);
const newMappings = await sql`
  SELECT
    COUNT(*) FILTER (
      WHERE m.match_method IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM hmrc_company_mapping_audit_phase0a a
        WHERE a.organisation_name = m.organisation_name
          AND a.verdict IN ('requires_human_review', 'requires_human_review_ch')
      )
    )::int AS new_since_phase1,
    COUNT(*) FILTER (WHERE m.match_method IS NULL)::int AS total_null_provenance,
    COUNT(*) FILTER (WHERE m.match_method IS NULL)::int -
      COUNT(*) FILTER (
        WHERE m.match_method IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM hmrc_company_mapping_audit_phase0a a
          WHERE a.organisation_name = m.organisation_name
            AND a.verdict IN ('requires_human_review', 'requires_human_review_ch')
        )
      )::int AS deliberate_human_review_skips
  FROM hmrc_company_mapping m
`;
console.table(newMappings);
console.log(
  '  new_since_phase1 = sponsors whose org name is NOT in the human_review staging',
);
console.log(
  '  AND has no provenance — i.e. created post-Phase-1 by something other than',
);
console.log(
  '  phase1_apply (likely getCompanyProfile.else). Higher = more urgent Phase 3.',
);

// Sample 10 such rows, ordered by organisation_name for a stable, debugger-friendly
// view (verified_at is NULL on most leak rows since the on-demand resolver
// doesn't write provenance, so ordering by it isn't meaningful).
const newSample = await sql`
  SELECT m.organisation_name, m.company_number, m.match_method, m.verified_at
  FROM hmrc_company_mapping m
  WHERE m.match_method IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM hmrc_company_mapping_audit_phase0a a
      WHERE a.organisation_name = m.organisation_name
        AND a.verdict IN ('requires_human_review', 'requires_human_review_ch')
    )
  ORDER BY m.organisation_name
  LIMIT 10
`;
if (newSample.length > 0) {
  console.log(
    '\n  Sample of new-since-Phase-1 mappings (alphabetical by org name):',
  );
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
