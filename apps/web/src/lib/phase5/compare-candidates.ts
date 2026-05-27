/**
 * Pairwise inline resolver for same-rank ties. Decides between the incumbent
 * (`existing`) mapping and the resolver's proposed candidate without writing
 * to the DB or making CH calls. Returns the intent (`promote` / `keep` /
 * `inconclusive`) for the orchestrator to dispatch.
 *
 * Single source of truth: both the live sweep and the one-shot drain script
 * call this. There is no second implementation to drift out of sync.
 *
 * See docs/phase5-sweep-algorithm.md §"`compareForInlineResolution`".
 */

import { normaliseForComparison } from '../hmrc-ch/pipeline.ts';
import type { ScorerCandidate, ScorerSponsor } from './score-candidate.ts';
import { scoreCandidate } from './score-candidate.ts';

/** Explicit, tunable bias toward the incumbent. Separates "stay put"
 *  preference from sponsor-fit content scoring. */
export const STATUS_QUO_BONUS = 1;

/** Minimum score difference required to flip the decision. Tuned for the
 *  reduced sponsor-fit feature set (max raw score +4, since the doc's
 *  postcode-area feature is dropped — HMRC publishes no postcodes). At 2, a
 *  locality match alone (raw diff 3, effective diff 2 after the bonus) stays
 *  `inconclusive`, but locality + status advantage (raw diff 4+, effective
 *  diff 3+) wins. Succession evidence (+5) dominates either side regardless. */
export const SCORE_MARGIN = 2;

/** Weight applied when one candidate's canonical name appears in the other's
 *  `previous_company_names`. Strong evidence of corporate succession. */
export const SUCCESSION_WEIGHT = 5;

export type CompareCandidate = ScorerCandidate & {
  company_name: string;
  previous_company_names?: { name: string }[] | null;
};

export type CompareAction = 'promote' | 'keep' | 'inconclusive';

export type CompareResult = {
  s_e: number;
  s_p: number;
  action: CompareAction;
};

/** Strips trailing legal suffix and uppercases, matching the convention used by
 *  the resolver's Tier A / Tier B matchers. */
function canonical(name: string | null | undefined): string | null {
  if (!name) return null;
  const c = normaliseForComparison(name);
  return c.length > 0 ? c : null;
}

/** Returns true if `target` (already canonicalised) appears in any entry of
 *  the candidate's previous-name list, also canonicalised. */
function previousNamesInclude(
  list: { name: string }[] | null | undefined,
  target: string,
): boolean {
  if (!list || list.length === 0) return false;
  for (const entry of list) {
    const c = canonical(entry.name);
    if (c === target) return true;
  }
  return false;
}

/** Decides which candidate fits the sponsor better. The incumbent
 *  (`existing`) carries `STATUS_QUO_BONUS`; the contender must exceed it by
 *  `SCORE_MARGIN` to win. */
export function compareForInlineResolution(
  existing: CompareCandidate,
  proposed: CompareCandidate,
  sponsor: ScorerSponsor,
): CompareResult {
  let s_e = scoreCandidate(existing, sponsor) + STATUS_QUO_BONUS;
  let s_p = scoreCandidate(proposed, sponsor);

  const existingCanon = canonical(existing.company_name);
  const proposedCanon = canonical(proposed.company_name);

  if (
    proposedCanon &&
    previousNamesInclude(existing.previous_company_names, proposedCanon)
  ) {
    s_e += SUCCESSION_WEIGHT;
  }
  if (
    existingCanon &&
    previousNamesInclude(proposed.previous_company_names, existingCanon)
  ) {
    s_p += SUCCESSION_WEIGHT;
  }

  if (s_p > s_e + SCORE_MARGIN) return { s_e, s_p, action: 'promote' };
  if (s_e > s_p + SCORE_MARGIN) return { s_e, s_p, action: 'keep' };
  return { s_e, s_p, action: 'inconclusive' };
}
