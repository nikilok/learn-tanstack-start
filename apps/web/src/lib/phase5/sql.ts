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
import type { SweepDeps, SweepSponsor, Tier } from './sweep.ts';

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

/** Build a `lookupSponsor` matching `SweepDeps['lookupSponsor']`. Pulls
 *  `route` from `hmrc_skilled_workers` for the inline scorer's route-type
 *  hard gate. Locality is always null since the 2026-06 HMRC feed dropped
 *  town/county — the resolver's geographic tiebreak is inert. */
export function makeLookupSponsor(sql: Sql): SweepDeps['lookupSponsor'] {
  return async (organisationName) => {
    // `ORDER BY id ASC` for deterministic row selection — `hmrc_skilled_workers`
    // has multiple rows per organisation_name (one per route × type_rating
    // combination). Without an explicit order, the row picked for the
    // resolver's tiebreak depends on Postgres's storage order, which can
    // shift between runs. (CodeRabbit PR #85, comment 2.)
    const rows = (await sql`
      SELECT route
      FROM hmrc_skilled_workers
      WHERE organisation_name = ${organisationName}
      ORDER BY id ASC
      LIMIT 1
    `) as {
      route: string | null;
    }[];
    const first = rows[0];
    return {
      townCity: null,
      county: null,
      route: first?.route ?? null,
    } satisfies SweepSponsor;
  };
}

/** Build a `getProfile` matching `SweepDeps['getProfile']`. Reads from the
 *  `companies_house_profiles` cache and reconstructs the structural shape
 *  the comparer expects. Returns null when the row isn't cached. */
export function makeGetProfile(sql: Sql): SweepDeps['getProfile'] {
  return async (companyNumber) => {
    const rows = (await sql`
      SELECT company_number, company_name, company_status, company_type,
             locality, previous_company_names
      FROM companies_house_profiles
      WHERE company_number = ${companyNumber}
      LIMIT 1
    `) as {
      company_number: string;
      company_name: string;
      company_status: string | null;
      company_type: string | null;
      locality: string | null;
      previous_company_names: string[] | null;
    }[];
    const r = rows[0];
    if (!r) return null;
    return {
      company_number: r.company_number,
      company_name: r.company_name,
      company_status: r.company_status ?? undefined,
      type: r.company_type ?? undefined,
      registered_office_address: r.locality
        ? { locality: r.locality }
        : undefined,
      previous_company_names: (r.previous_company_names ?? []).map((name) => ({
        name,
      })),
    } satisfies CHFullProfile;
  };
}

/** Build a `bumpVerifiedAt` matching `SweepDeps['bumpVerifiedAt']`. The
 *  optimistic-lock WHERE clause means a concurrent writer's update is
 *  detected as a 0-row UPDATE and silently skipped — the row will reappear
 *  in a future sweep window. No audit row written; the audit table is
 *  reserved for material corrections. */
export function makeBumpVerifiedAt(sql: Sql): SweepDeps['bumpVerifiedAt'] {
  return async (existing) => {
    // Lock compares at millisecond precision: Postgres stores verified_at with
    // microseconds, but neon → JS Date truncates to ms on read. Without the
    // date_trunc, a row whose verified_at has any non-zero microseconds (i.e.
    // any row touched by a previous SQL `now()`) would silently lock-miss.
    await sql`
      UPDATE hmrc_company_mapping
      SET verified_at = now()
      WHERE organisation_name = ${existing.organisationName}
        AND date_trunc('milliseconds', verified_at)
            IS NOT DISTINCT FROM ${existing.verifiedAt}
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
 *  pipeline and maps its `ResolveResult` shape to `ProposedResolution`.
 *  The resolver only consumes `townCity` / `county`; `route` is sweep-scope
 *  and projected out before the call. */
export function makeResolveSponsor(
  resolver: ResolverFn,
): SweepDeps['resolveSponsor'] {
  return async (organisationName, sponsor) => {
    const result = await resolver(organisationName, {
      townCity: sponsor.townCity,
      county: sponsor.county,
    });
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
    // Lock compares at millisecond precision: see comment in
    // `makeBumpVerifiedAt` — same microsecond-truncation issue.
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
          AND date_trunc('milliseconds', verified_at)
              IS NOT DISTINCT FROM ${input.originalVerifiedAt}
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
