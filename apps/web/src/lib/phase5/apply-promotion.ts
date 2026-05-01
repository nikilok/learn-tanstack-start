/**
 * Atomic write path for a Phase 5 promotion. Encapsulates the UPDATE +
 * RETURNING + audit INSERT (in a single CTE round-trip) plus the conditional
 * profile UPSERT, all behind injected dependencies so the orchestration is
 * unit-testable. The thin CLI wires the real SQL CTE / Drizzle helpers /
 * `upsertProfile` from `companiesHouse.ts` into these slots.
 */

import type {
  CHFullProfile,
  ExistingMapping,
  MatchMethod,
  ProposedResolution,
} from './decide.ts';

export type { CHFullProfile };

/** Inputs for the atomic mapping UPDATE + audit INSERT CTE. The orchestrator
 *  passes both the new state (going into the UPDATE) and the audit fields
 *  (`oldCompanyNumber`, `oldMatchMethod`, `changedBy`) so the CTE can capture
 *  them in one round-trip without a separate SELECT. */
export type CommitPromotionInput = {
  organisationName: string;
  originalVerifiedAt: Date | null;
  newCompanyNumber: string | null;
  newMatchMethod: MatchMethod | null;
  newMatchScore: number | null;
  newQueryUsed: string | null;
  newIsPublicBody: boolean;
  oldCompanyNumber: string | null;
  oldMatchMethod: MatchMethod | null;
  changedBy: string;
};

/** Shape returned by the UPDATE … RETURNING clause. `null` means the optimistic
 *  lock missed (concurrent writer changed `verified_at`). */
export type CommitPromotionResult = {
  organisationName: string;
  newCompanyNumber: string | null;
  newMatchMethod: MatchMethod | null;
} | null;

export type ApplyPromotionDeps = {
  commitPromotion: (
    input: CommitPromotionInput,
  ) => Promise<CommitPromotionResult>;
  upsertProfile: (profile: CHFullProfile) => Promise<void>;
};

export type ApplyPromotionResult =
  | { ok: true }
  | { ok: false; reason: 'lock_missed' };

/** Apply a Phase 5 promotion. Returns lock_missed if the optimistic lock fails. */
export async function applyPromotion(
  existing: ExistingMapping,
  proposed: ProposedResolution,
  changedBy: string,
  deps: ApplyPromotionDeps,
): Promise<ApplyPromotionResult> {
  const committed = await deps.commitPromotion({
    organisationName: existing.organisationName,
    originalVerifiedAt: existing.verifiedAt,
    newCompanyNumber: proposed.companyNumber,
    newMatchMethod: proposed.matchMethod,
    newMatchScore: proposed.matchScore,
    newQueryUsed: proposed.queryUsed,
    newIsPublicBody: proposed.verdict === 'public_body',
    oldCompanyNumber: existing.companyNumber,
    oldMatchMethod: existing.matchMethod,
    changedBy,
  });

  if (committed === null) return { ok: false, reason: 'lock_missed' };

  if (proposed.verdict === 'verified' && proposed.profile) {
    await deps.upsertProfile(proposed.profile);
  }

  return { ok: true };
}
