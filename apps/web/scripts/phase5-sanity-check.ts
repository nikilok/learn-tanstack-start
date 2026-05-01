/**
 * Post-Phase-5 sanity check. Run anytime to verify the per-tier sweep cron is
 * actually rotating through its slice of `hmrc_company_mapping`, that
 * promotions land in the audit table, and that the review queue is draining.
 *
 * Companion to `phase1-sanity-check.ts`. Run anytime — read-only, no API
 * calls, ~1s wall time.
 *
 * Run from monorepo root:  bun apps/web/scripts/phase5-sanity-check.ts
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

function describeDbHost(url: string | undefined): string {
  if (!url) return '(not set)';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

console.log('Phase 5 sanity check');
console.log(`  db host: ${describeDbHost(process.env.POSTGRES_URL)}`);
console.log(
  '═════════════════════════════════════════════════════════════════\n',
);

// 1. Phase 5 audit attribution. Counts every row in
//    hmrc_company_mapping_audit attributed to a phase5_sweep_* changed_by.
//    Each row is one promotion (update) — bumps don't write audit rows by
//    design. So this is the count of *material corrections* the sweep has
//    made, broken down per tier.
console.log('1) Phase 5 audit attribution (one row per promotion / update)');
const auditByTier = await sql`
  SELECT changed_by,
         COUNT(*)::int AS audit_rows,
         MIN(changed_at)::text AS first_run,
         MAX(changed_at)::text AS last_run
  FROM hmrc_company_mapping_audit
  WHERE changed_by LIKE 'phase5_sweep_%'
  GROUP BY changed_by
  ORDER BY changed_by
`;
if (auditByTier.length === 0) {
  console.log(
    '  No phase5_sweep_* audit rows yet. Either the sweep has never run, or it has run',
  );
  console.log(
    '  but every row resolved to a bump (same-tier-same-number, the common case).',
  );
} else {
  console.table(auditByTier);
}

// 2. Per-tier rotation status. The sweep's *bump* path doesn't write audit
//    rows, so the only DB-visible signal that a tier ran is `verified_at`
//    advancing on its rows. For each tier, show how the verified_at field
//    is distributed across the row population — if MIN(verified_at) is
//    recent, the cron is keeping up; if MIN is months old, the cron has
//    fallen behind its rotation cadence.
console.log(`\n2) Per-tier rotation status (verified_at distribution)`);
const tierRotation = await sql`
  SELECT
    COALESCE(match_method, 'NULL') AS match_method,
    COUNT(*)::int AS rows,
    COUNT(*) FILTER (WHERE verified_at IS NULL)::int AS unverified,
    MIN(verified_at)::text AS oldest_verified_at,
    MAX(verified_at)::text AS newest_verified_at,
    EXTRACT(epoch FROM (MAX(verified_at) - MIN(verified_at)))::int / 86400 AS span_days
  FROM hmrc_company_mapping
  WHERE match_method IN ('no_match', 'token_sim', 'previous_name', 'exact', 'public_body')
     OR match_method IS NULL
  GROUP BY match_method
  ORDER BY rows DESC
`;
console.table(tierRotation);
console.log(
  '  Expected after sweep is established (per the doc tier cadences):',
);
console.log('    no_match     → oldest_verified_at within the last ~4 days');
console.log(
  '    token_sim    → oldest within ~1 week  (Tier 2: token_sim + previous_name)',
);
console.log('    previous_name → same as token_sim');
console.log('    exact        → oldest within ~10 weeks (lowest priority)');
console.log('    public_body  → oldest within ~30 days (monthly cadence)');

// 3. Tier-transition matrix. For every Phase 5 audit row, which match_method
//    it came from and which it went to. This is the corrections feed —
//    promotions are real Tier-C → Tier-A flips; same-tier different-number
//    transitions should never appear here (those go to the review queue).
console.log(`\n3) Tier transitions from Phase 5 promotions (last 30 days)`);
const transitions = await sql`
  SELECT
    COALESCE(old_match_method, 'NULL') AS from_method,
    COALESCE(new_match_method, 'NULL') AS to_method,
    COUNT(*)::int AS count
  FROM hmrc_company_mapping_audit
  WHERE changed_by LIKE 'phase5_sweep_%'
    AND changed_at > now() - interval '30 days'
  GROUP BY old_match_method, new_match_method
  ORDER BY count DESC
`;
if (transitions.length === 0) {
  console.log('  No Phase 5 promotions in the last 30 days.');
} else {
  console.table(transitions);
  console.log(
    '  Healthy transitions: token_sim → exact, previous_name → exact,',
  );
  console.log('  no_match → exact (newly-incorporated CH entity resolved).');
  console.log(
    '  Suspicious: any transition *out of* exact (rule 5 should reject demotions).',
  );
}

// 4. Review queue snapshot. For each `reason`, total + unresolved + oldest.
//    Unresolved rows here represent ambiguous cases the sweep deferred to
//    human / agentic review (manual_conflict, public_body_conflict,
//    same_rank_different_number).
console.log(`\n4) Review queue health`);
const queueStats = await sql`
  SELECT
    reason,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved,
    MIN(detected_at) FILTER (WHERE resolved_at IS NULL)::text AS oldest_unresolved
  FROM hmrc_company_mapping_review_queue
  GROUP BY reason
  ORDER BY unresolved DESC, total DESC
`;
if (queueStats.length === 0) {
  console.log('  Review queue is empty (no ambiguous transitions detected).');
} else {
  console.table(queueStats);
  console.log(
    '  manual_conflict           = sweep wanted to overwrite a manual override',
  );
  console.log(
    '  public_body_conflict      = sweep wanted to swap public_body ↔ verified',
  );
  console.log(
    '  same_rank_different_number = legitimate correction vs. CH ranking drift',
  );
}

// 5. Recent activity per tier — when did each cron last write to the audit
//    table? If a tier hasn't shown activity in N×its cadence, the workflow
//    likely isn't running.
console.log(`\n5) Most recent activity per tier (proxy for cron liveness)`);
const recentActivity = await sql`
  SELECT
    changed_by,
    MAX(changed_at)::text AS last_audit_write,
    EXTRACT(epoch FROM (now() - MAX(changed_at)))::int / 3600 AS hours_since
  FROM hmrc_company_mapping_audit
  WHERE changed_by LIKE 'phase5_sweep_%'
  GROUP BY changed_by
  ORDER BY changed_by
`;
if (recentActivity.length === 0) {
  console.log(
    '  No Phase 5 audit writes recorded yet. Either no promotions have happened',
  );
  console.log('  (every tick has been a bump), or the cron hasn’t fired yet.');
} else {
  console.table(recentActivity);
  console.log('  Stale-cron heuristic (hours_since exceeds the cadence):');
  console.log('    phase5_sweep_no_match     → expect < 24h');
  console.log('    phase5_sweep_non_exact    → expect < 84h (3.5 days)');
  console.log('    phase5_sweep_exact        → expect < 24h');
  console.log('    phase5_sweep_public_body  → expect < 720h (30 days)');
}

console.log('\nDone.');
