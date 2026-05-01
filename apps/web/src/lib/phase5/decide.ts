/**
 * Pure decision function for the Phase 5 sweep. Maps an existing mapping +
 * the resolver's proposed verdict to one of four sweep actions: bump, update,
 * queue, no_op. No I/O.
 *
 * See docs/phase5-sweep-algorithm.md for the rule table.
 */

export type MatchMethod =
  | 'exact'
  | 'previous_name'
  | 'token_sim'
  | 'no_match'
  | 'public_body'
  | 'manual';

export type ExistingMapping = {
  organisationName: string;
  companyNumber: string | null;
  matchMethod: MatchMethod | null;
  matchScore: string | null;
  verifiedAt: Date | null;
  isPublicBody: boolean;
};

export type ProposedVerdict =
  | 'verified'
  | 'public_body'
  | 'no_match'
  | 'human_review';

export type ProposedResolution = {
  verdict: ProposedVerdict;
  companyNumber: string | null;
  matchMethod: MatchMethod | null;
  matchScore: number | null;
  queryUsed: string | null;
};

export type QueueReason =
  | 'manual_conflict'
  | 'public_body_conflict'
  | 'same_rank_different_number';

export type DecideResult =
  | { action: 'bump' }
  | { action: 'update' }
  | { action: 'queue'; reason: QueueReason };

/** Numeric rank for the upgrade-only ladder. Terminal peers (`public_body`,
 *  `manual`) are handled separately and intentionally not in this map. */
const RANK: Record<string, number> = {
  no_match: 0,
  human_review: 1,
  token_sim: 2,
  previous_name: 3,
  exact: 4,
};

function existingRank(existing: ExistingMapping): number {
  if (existing.matchMethod && existing.matchMethod in RANK) {
    return RANK[existing.matchMethod];
  }
  return RANK.human_review;
}

function proposedRank(proposed: ProposedResolution): number {
  if (proposed.verdict === 'verified' && proposed.matchMethod) {
    return RANK[proposed.matchMethod] ?? 0;
  }
  if (proposed.verdict === 'no_match') return RANK.no_match;
  return 0;
}

/** Apply the upgrade-only sweep policy to a single row. */
export function decide(
  existing: ExistingMapping,
  proposed: ProposedResolution,
): DecideResult {
  if (proposed.verdict === 'human_review') return { action: 'bump' };

  if (existing.matchMethod === 'manual') {
    if (
      proposed.verdict === 'verified' &&
      proposed.companyNumber === existing.companyNumber
    ) {
      return { action: 'bump' };
    }
    return { action: 'queue', reason: 'manual_conflict' };
  }

  const existingIsPublicBody = existing.matchMethod === 'public_body';
  const proposedIsPublicBody = proposed.verdict === 'public_body';
  if (existingIsPublicBody && proposedIsPublicBody) return { action: 'bump' };
  if (existingIsPublicBody && proposed.verdict === 'verified') {
    return { action: 'queue', reason: 'public_body_conflict' };
  }
  if (proposedIsPublicBody && existing.matchMethod !== 'no_match') {
    return { action: 'queue', reason: 'public_body_conflict' };
  }
  if (proposedIsPublicBody && existing.matchMethod === 'no_match') {
    return { action: 'update' };
  }

  const eRank = existingRank(existing);
  const pRank = proposedRank(proposed);
  if (pRank > eRank) return { action: 'update' };
  if (pRank < eRank) return { action: 'bump' };

  if (existing.companyNumber === proposed.companyNumber) {
    return { action: 'bump' };
  }
  return { action: 'queue', reason: 'same_rank_different_number' };
}
