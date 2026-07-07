/**
 * Pure decision function for the Phase 5 sweep. Maps an existing mapping +
 * the resolver's proposed verdict to one of four sweep actions: bump, update,
 * inline_score, log_and_bump. No I/O.
 *
 * `inline_score` signals the orchestrator to run `compareForInlineResolution`
 * over the existing + proposed CH profiles and dispatch the result. The
 * scorer call lives in the orchestrator, not here, so `decide()` stays pure
 * and unit-testable without DB / CH access.
 *
 * See docs/phase5-sweep-algorithm.md for the rule table.
 */

export type MatchMethod =
  | 'exact'
  | 'exact_squash'
  | 'previous_name'
  | 'token_sim'
  | 'fuzzy_edit'
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

type ProposedVerdict = 'verified' | 'public_body' | 'no_match' | 'human_review';

/** Structural superset of the CH `/company/{number}` payload. Kept loose
 *  (extra `[key: string]: unknown` index) so this type stays compatible with
 *  the resolver's own `CHFullProfile` declaration in
 *  `apps/web/src/lib/hmrc-ch/resolve-sponsor.ts`. */
export type CHFullProfile = {
  company_number: string;
  company_name: string;
  company_status?: string;
  [key: string]: unknown;
};

export type ProposedResolution = {
  verdict: ProposedVerdict;
  companyNumber: string | null;
  matchMethod: MatchMethod | null;
  matchScore: number | null;
  queryUsed: string | null;
  profile?: CHFullProfile;
  /** Top CH search results captured for the review queue's audit jsonb. */
  topResults?: unknown[];
};

export type LogAndBumpReason = 'manual_conflict' | 'public_body_conflict';

export type DecideResult =
  | { action: 'bump' }
  | { action: 'update' }
  | { action: 'inline_score' }
  | { action: 'log_and_bump'; reason: LogAndBumpReason };

/** Numeric rank for the upgrade-only ladder. Terminal peers (`public_body`,
 *  `manual`) are handled separately and intentionally not in this map.
 *  `fuzzy_edit` deliberately ties `token_sim` (both are fuzzy name evidence;
 *  the inline scorer arbitrates cross-method ties); `exact_squash`
 *  (punctuation-only variance) sits between `previous_name` and `exact`. */
const RANK: Record<string, number> = {
  no_match: 0,
  human_review: 1,
  fuzzy_edit: 2,
  token_sim: 2,
  previous_name: 3,
  exact_squash: 4,
  exact: 5,
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
    return { action: 'log_and_bump', reason: 'manual_conflict' };
  }

  const existingIsPublicBody = existing.matchMethod === 'public_body';
  const proposedIsPublicBody = proposed.verdict === 'public_body';
  // Legacy NULL-method rows (pre-Phase-1 top-hit mappings) carry no defensible
  // signal, same as no_match — a positive public_body identification promotes
  // them rather than warning forever.
  const existingIsUnresolved =
    existing.matchMethod === 'no_match' || existing.matchMethod === null;
  if (existingIsPublicBody && proposedIsPublicBody) return { action: 'bump' };
  if (existingIsPublicBody && proposed.verdict === 'verified') {
    return { action: 'log_and_bump', reason: 'public_body_conflict' };
  }
  if (proposedIsPublicBody && !existingIsUnresolved) {
    return { action: 'log_and_bump', reason: 'public_body_conflict' };
  }
  if (proposedIsPublicBody && existingIsUnresolved) {
    return { action: 'update' };
  }

  const eRank = existingRank(existing);
  const pRank = proposedRank(proposed);
  if (pRank > eRank) return { action: 'update' };
  if (pRank < eRank) return { action: 'bump' };

  if (existing.companyNumber === proposed.companyNumber) {
    return { action: 'bump' };
  }
  return { action: 'inline_score' };
}
