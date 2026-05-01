/**
 * Real Postgres-backed implementations of the Phase 5 dependency slots
 * declared by `sweep.ts` and `apply-promotion.ts`. Each function is a
 * factory that closes over a `neon`-style sql client (and any auxiliary
 * helpers) and returns a function shaped for direct injection into
 * `SweepDeps` / `ApplyPromotionDeps`.
 *
 * Not yet wired into a CLI — the thin entrypoint at
 * `apps/web/scripts/phase5-sweep.ts` will assemble these into a complete
 * deps object alongside `resolveOneSponsor` + `upsertProfile`.
 *
 * Atomicity: `commitPromotion` runs the doc-mandated atomic CTE (UPDATE +
 * RETURNING feeding INSERT INTO audit) so the mapping write and audit
 * row land in a single Postgres round-trip. This closes the two-statement
 * race window Phase 1 deferred (see hmrc-ch-mapping-fix.md "Known
 * reliability gap").
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { ResolveResult } from '../hmrc-ch/resolve-sponsor.ts';
import type {
  ApplyPromotionDeps,
  CommitPromotionInput,
  CommitPromotionResult,
} from './apply-promotion.ts';
import type {
  CHFullProfile,
  ExistingMapping,
  MatchMethod,
  ProposedResolution,
} from './decide.ts';
import type { SweepDeps, SweepLocality, Tier } from './sweep.ts';

/** Tagged-template SQL function shape returned by `neon(url)` with default
 *  flags — arrayMode=false, fullResults=false. Each query returns
 *  `Record<string, any>[]`; callers cast to their expected row shape. */
type Sql = NeonQueryFunction<false, false>;

// ─────────────────────────────────────────────────────────────────────────────
// SweepDeps factories
// ─────────────────────────────────────────────────────────────────────────────

type RawMappingRow = {
  organisation_name: string;
  company_number: string | null;
  match_method: MatchMethod | null;
  match_score: string | null;
  verified_at: Date | null;
  is_public_body: boolean;
};

/** Build a `selectRows` matching `SweepDeps['selectRows']`. Filters by tier
 *  predicate, ordered by `verified_at` (oldest / null first). */
export function makeSelectRows(sql: Sql): SweepDeps['selectRows'] {
  return async (tier, maxRows) => {
    const rows = await selectRowsForTier(sql, tier, maxRows);
    return rows.map(toExistingMapping);
  };
}

async function selectRowsForTier(
  sql: Sql,
  tier: Tier,
  maxRows: number,
): Promise<RawMappingRow[]> {
  if (tier === 'no_match') {
    return (await sql`
      SELECT organisation_name, company_number, match_method, match_score,
             verified_at, is_public_body
      FROM hmrc_company_mapping
      WHERE match_method = 'no_match'
      ORDER BY verified_at ASC NULLS FIRST
      LIMIT ${maxRows}
    `) as RawMappingRow[];
  }
  if (tier === 'non_exact') {
    return (await sql`
      SELECT organisation_name, company_number, match_method, match_score,
             verified_at, is_public_body
      FROM hmrc_company_mapping
      WHERE match_method IN ('token_sim', 'previous_name')
      ORDER BY verified_at ASC NULLS FIRST
      LIMIT ${maxRows}
    `) as RawMappingRow[];
  }
  if (tier === 'exact') {
    return (await sql`
      SELECT organisation_name, company_number, match_method, match_score,
             verified_at, is_public_body
      FROM hmrc_company_mapping
      WHERE match_method = 'exact'
      ORDER BY verified_at ASC NULLS FIRST
      LIMIT ${maxRows}
    `) as RawMappingRow[];
  }
  return (await sql`
    SELECT organisation_name, company_number, match_method, match_score,
           verified_at, is_public_body
    FROM hmrc_company_mapping
    WHERE match_method = 'public_body'
    ORDER BY verified_at ASC NULLS FIRST
    LIMIT ${maxRows}
  `) as RawMappingRow[];
}

function toExistingMapping(row: RawMappingRow): ExistingMapping {
  return {
    organisationName: row.organisation_name,
    companyNumber: row.company_number,
    matchMethod: row.match_method,
    matchScore: row.match_score,
    verifiedAt: row.verified_at,
    isPublicBody: row.is_public_body,
  };
}

/** Build a `lookupLocality` matching `SweepDeps['lookupLocality']`. Pulls
 *  `town_city` / `county` from `hmrc_skilled_workers` for the locality
 *  tiebreak inside `resolveOneSponsor`. */
export function makeLookupLocality(sql: Sql): SweepDeps['lookupLocality'] {
  return async (organisationName) => {
    const rows = (await sql`
      SELECT town_city, county
      FROM hmrc_skilled_workers
      WHERE organisation_name = ${organisationName}
      LIMIT 1
    `) as { town_city: string | null; county: string | null }[];
    const first = rows[0];
    return {
      townCity: first?.town_city ?? null,
      county: first?.county ?? null,
    } satisfies SweepLocality;
  };
}

/** Build a `bumpVerifiedAt` matching `SweepDeps['bumpVerifiedAt']`. The
 *  optimistic-lock WHERE clause means a concurrent writer's update is
 *  detected as a 0-row UPDATE and silently skipped — the row will reappear
 *  in a future sweep window. No audit row written; the audit table is
 *  reserved for material corrections. */
export function makeBumpVerifiedAt(sql: Sql): SweepDeps['bumpVerifiedAt'] {
  return async (existing) => {
    await sql`
      UPDATE hmrc_company_mapping
      SET verified_at = now()
      WHERE organisation_name = ${existing.organisationName}
        AND verified_at IS NOT DISTINCT FROM ${existing.verifiedAt}
    `;
  };
}

/** Build an `enqueueReview` matching `SweepDeps['enqueueReview']`. Uses an
 *  INSERT … WHERE NOT EXISTS for DB-level idempotency: if an unresolved
 *  row already exists for the same (organisation_name, reason), the INSERT
 *  is skipped. Prevents the queue stacking duplicate rows for a sponsor
 *  whose review is still pending across sweep cycles. */
export function makeEnqueueReview(sql: Sql): SweepDeps['enqueueReview'] {
  return async (existing, proposed, reason, detectedBy) => {
    const topResultsJson = proposed.topResults
      ? JSON.stringify(proposed.topResults)
      : null;
    await sql`
      INSERT INTO hmrc_company_mapping_review_queue (
        organisation_name,
        reason,
        existing_company_number,
        existing_match_method,
        existing_match_score,
        proposed_company_number,
        proposed_match_method,
        proposed_match_score,
        proposed_query_used,
        ch_search_results_top5,
        detected_by
      )
      SELECT
        ${existing.organisationName},
        ${reason},
        ${existing.companyNumber},
        ${existing.matchMethod},
        ${existing.matchScore},
        ${proposed.companyNumber},
        ${proposed.matchMethod},
        ${proposed.matchScore},
        ${proposed.queryUsed},
        ${topResultsJson}::jsonb,
        ${detectedBy}
      WHERE NOT EXISTS (
        SELECT 1 FROM hmrc_company_mapping_review_queue
        WHERE organisation_name = ${existing.organisationName}
          AND reason = ${reason}
          AND resolved_at IS NULL
      )
    `;
  };
}

/** Promise-based sleep for the per-row rate-limit delay. Real impl wraps
 *  `setTimeout`; tests pass a mock that records the requested ms. */
export function makeSleep(): SweepDeps['sleep'] {
  return (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver wiring (calls into the existing hmrc-ch shared lib)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolver function shape — the CLI passes a closure around `resolveOneSponsor`
 *  with `fetchApi` already curried in. */
type ResolverFn = (
  organisationName: string,
  locality: { townCity: string | null; county: string | null },
) => Promise<ResolveResult>;

/** Build a `resolveSponsor` matching `SweepDeps['resolveSponsor']`. Wraps
 *  the existing `resolveOneSponsor` helper from the shared HMRC↔CH
 *  pipeline and maps its `ResolveResult` shape to `ProposedResolution`. */
export function makeResolveSponsor(
  resolver: ResolverFn,
): SweepDeps['resolveSponsor'] {
  return async (organisationName, locality) => {
    const result = await resolver(organisationName, locality);
    return toProposedResolution(result);
  };
}

function toProposedResolution(result: ResolveResult): ProposedResolution {
  if (result.verdict === 'verified') {
    return {
      verdict: 'verified',
      companyNumber: result.companyNumber,
      matchMethod: result.matchMethod,
      matchScore: result.matchScore,
      queryUsed: result.queryUsed,
      profile: result.profile as CHFullProfile,
    };
  }
  if (result.verdict === 'public_body') {
    return {
      verdict: 'public_body',
      companyNumber: null,
      matchMethod: 'public_body',
      matchScore: null,
      queryUsed: null,
    };
  }
  if (result.verdict === 'no_match') {
    return {
      verdict: 'no_match',
      companyNumber: null,
      matchMethod: 'no_match',
      matchScore: null,
      queryUsed: result.queryUsed,
      topResults: result.topResults,
    };
  }
  return {
    verdict: 'human_review',
    companyNumber: null,
    matchMethod: null,
    matchScore: null,
    queryUsed: result.queryUsed,
    topResults: result.topResults,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ApplyPromotionDeps factory — the atomic CTE
// ─────────────────────────────────────────────────────────────────────────────

type RawCommitResult = {
  company_number: string | null;
  match_method: MatchMethod | null;
};

/** Build a `commitPromotion` matching `ApplyPromotionDeps['commitPromotion']`.
 *
 *  Runs the atomic UPDATE + audit INSERT in a single CTE. Returns null when
 *  the optimistic-lock WHERE clause matches zero rows (concurrent writer
 *  changed `verified_at` between SELECT and UPDATE). The audit row is
 *  written by the same statement, so there is no two-statement race window.
 */
export function makeCommitPromotion(
  sql: Sql,
): ApplyPromotionDeps['commitPromotion'] {
  return async (
    input: CommitPromotionInput,
  ): Promise<CommitPromotionResult> => {
    const rows = (await sql`
      WITH updated AS (
        UPDATE hmrc_company_mapping
        SET company_number = ${input.newCompanyNumber},
            match_method   = ${input.newMatchMethod},
            match_score    = ${input.newMatchScore},
            query_used     = ${input.newQueryUsed},
            is_public_body = ${input.newIsPublicBody},
            verified_at    = now()
        WHERE organisation_name = ${input.organisationName}
          AND verified_at IS NOT DISTINCT FROM ${input.originalVerifiedAt}
        RETURNING company_number, match_method
      ),
      audit_inserted AS (
        INSERT INTO hmrc_company_mapping_audit (
          organisation_name,
          old_company_number,
          new_company_number,
          old_match_method,
          new_match_method,
          changed_by
        )
        SELECT
          ${input.organisationName},
          ${input.oldCompanyNumber},
          updated.company_number,
          ${input.oldMatchMethod},
          updated.match_method,
          ${input.changedBy}
        FROM updated
        RETURNING 1
      )
      SELECT company_number, match_method FROM updated
    `) as RawCommitResult[];
    const row = rows[0];
    if (!row) return null;
    return {
      organisationName: input.organisationName,
      newCompanyNumber: row.company_number,
      newMatchMethod: row.match_method,
    };
  };
}
