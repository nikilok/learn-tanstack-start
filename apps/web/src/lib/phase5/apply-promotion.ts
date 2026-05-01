/**
 * Atomic write path for a Phase 5 promotion. Encapsulates the UPDATE +
 * RETURNING + audit INSERT + conditional profile UPSERT, all behind injected
 * dependencies so the orchestration is unit-testable. The thin CLI wires the
 * real SQL CTE / Drizzle helpers / `upsertProfile` from `companiesHouse.ts`
 * into these slots.
 */

import type {
  CHFullProfile,
  ExistingMapping,
  MatchMethod,
  ProposedResolution,
} from './decide.ts';

export type { CHFullProfile };

export type MappingUpdateInput = {
  organisationName: string;
  originalVerifiedAt: Date | null;
  newCompanyNumber: string | null;
  newMatchMethod: MatchMethod | null;
  newMatchScore: number | null;
  newQueryUsed: string | null;
  newIsPublicBody: boolean;
};

/** Shape returned by the UPDATE … RETURNING clause. `null` means lock missed. */
export type MappingUpdateResult = {
  organisationName: string;
  newCompanyNumber: string | null;
  newMatchMethod: MatchMethod | null;
} | null;

export type AuditInsertInput = {
  organisationName: string;
  oldCompanyNumber: string | null;
  newCompanyNumber: string | null;
  oldMatchMethod: MatchMethod | null;
  newMatchMethod: MatchMethod | null;
  changedBy: string;
};

export type ApplyPromotionDeps = {
  updateMapping: (input: MappingUpdateInput) => Promise<MappingUpdateResult>;
  insertAudit: (input: AuditInsertInput) => Promise<void>;
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
  const updated = await deps.updateMapping({
    organisationName: existing.organisationName,
    originalVerifiedAt: existing.verifiedAt,
    newCompanyNumber: proposed.companyNumber,
    newMatchMethod: proposed.matchMethod,
    newMatchScore: proposed.matchScore,
    newQueryUsed: proposed.queryUsed,
    newIsPublicBody: proposed.verdict === 'public_body',
  });

  if (updated === null) return { ok: false, reason: 'lock_missed' };

  await deps.insertAudit({
    organisationName: existing.organisationName,
    oldCompanyNumber: existing.companyNumber,
    newCompanyNumber: updated.newCompanyNumber,
    oldMatchMethod: existing.matchMethod,
    newMatchMethod: updated.newMatchMethod,
    changedBy,
  });

  if (proposed.verdict === 'verified' && proposed.profile) {
    await deps.upsertProfile(proposed.profile);
  }

  return { ok: true };
}
