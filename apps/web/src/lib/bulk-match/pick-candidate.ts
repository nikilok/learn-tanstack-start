/**
 * Per-organisation candidate selection for the bulk snapshot matcher.
 * Mirrors the online resolver's preferences: strongest tier first, active
 * companies over inactive within a tier, then the shared pickByLocality
 * tiebreak. Ambiguity fails closed ('tied' → no commit).
 */

import { pickByLocality, type ScoredCandidate } from '../hmrc-ch/pipeline.ts';
import type { OfflineHit, OfflineTier } from './backlog-index.ts';
import { isSnapshotActive, toCHCandidate } from './snapshot-row.ts';

const TIER_ORDER: Record<OfflineTier, number> = { A: 0, A2: 1, B: 2, D: 3 };

export type PickOutcome =
  | { kind: 'picked'; hit: OfflineHit }
  | { kind: 'tied' }
  | { kind: 'none' };

/** Picks the single best snapshot candidate for one org's hits. */
export function pickForOrg(
  hits: OfflineHit[],
  townCity: string | null,
  county: string | null,
): PickOutcome {
  if (hits.length === 0) return { kind: 'none' };

  // Active preference applies ACROSS tiers, exactly like the resolver's
  // cascade: an active Tier-B/D match beats an inactive Tier-A namesake
  // (the dissolved-namesake trap). Only when no hit is active at any tier
  // does the inactive pool compete.
  const active = hits.filter((h) => isSnapshotActive(h.company.status));
  const pool = active.length > 0 ? active : hits;

  const bestTier = Math.min(...pool.map((h) => TIER_ORDER[h.tier]));
  const contenders = pool.filter((h) => TIER_ORDER[h.tier] === bestTier);

  // One company can hit via both its current and a previous name — keep the
  // best-scoring hit per company number.
  const byNumber = new Map<string, OfflineHit>();
  for (const hit of contenders) {
    const existing = byNumber.get(hit.company.companyNumber);
    if (!existing || hit.score > existing.score) {
      byNumber.set(hit.company.companyNumber, hit);
    }
  }
  const unique = [...byNumber.values()];
  if (unique.length === 1) return { kind: 'picked', hit: unique[0] };

  const scored: ScoredCandidate[] = unique.map((h) => ({
    candidate: toCHCandidate(h.company),
    tier: h.tier,
    score: h.score,
  }));
  const picked = pickByLocality(scored, townCity, county);
  if (picked === 'tied') return { kind: 'tied' };

  const winner = unique.find(
    (h) => h.company.companyNumber === picked.candidate.company_number,
  );
  return winner ? { kind: 'picked', hit: winner } : { kind: 'tied' };
}
