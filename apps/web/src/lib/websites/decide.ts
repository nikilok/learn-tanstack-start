/**
 * Pure decision function for company website discovery. Maps an existing
 * company_websites row + a proposed finding to one of three actions. No I/O.
 *
 * The ladder is upgrade-only, mirroring lib/phase5/decide.ts: a weaker
 * discoverer can never overwrite a stronger one's answer, so the order the
 * importers and sweeps run in cannot change the result.
 *
 * Revalidation (demoting a live `verified` row to `dead`) is deliberately NOT
 * routed through here — it is a liveness check, not a discovery, and it is the
 * one legitimate way a row moves down the ladder.
 */

import { isSameSite } from './normalise-url';

export type WebsiteEvidence =
  | 'manual'
  | 'crn_on_page'
  | 'registry'
  | 'postcode_on_page'
  | 'llm_adjudicated'
  | 'registry_unconfirmed'
  | 'domain_similarity'
  | 'none';

export type WebsiteStatus =
  | 'pending'
  | 'verified'
  | 'candidate'
  | 'none'
  | 'dead';

export type ExistingWebsite = {
  url: string | null;
  status: WebsiteStatus;
  evidence: WebsiteEvidence;
  /** Which discoverer wrote this row; a source may revise its own answer. */
  source: string | null;
};

export type ProposedWebsite = {
  url: string | null;
  evidence: WebsiteEvidence;
  source: string;
};

export type DecideWebsiteResult =
  | { action: 'update' }
  | { action: 'keep' }
  | { action: 'conflict' };

/**
 * The whole ladder, weakest rung first. Rank is the index and confidence is
 * read straight off the rung, so the two orderings are one declaration rather
 * than two maps an agreement test has to police (apps/web/CLAUDE.md: prefer
 * structural impossibility over an agreement test). The SQL upgrade guard
 * compares stored confidence, so its ordering comes from here too.
 *
 * Tiers sharing a rung tie deliberately, as phase5's ladder ties
 * fuzzy_edit/token_sim: `registry_unconfirmed` is a registry row whose own
 * company name does not recognisably match Companies House, which is worth no
 * more and no less than an LLM's opinion.
 *
 * `manual` is terminal — an owner decision outranks every discoverer. The
 * verified/candidate boundary is VERIFIED_FLOOR: at or above it the answer is
 * backed by something found on the page or by an exact registry join.
 */
const LADDER: { tiers: WebsiteEvidence[]; confidence: number }[] = [
  { tiers: ['none'], confidence: 0 },
  { tiers: ['domain_similarity'], confidence: 0.4 },
  { tiers: ['registry_unconfirmed', 'llm_adjudicated'], confidence: 0.6 },
  { tiers: ['postcode_on_page'], confidence: 0.85 },
  { tiers: ['registry'], confidence: 0.95 },
  { tiers: ['crn_on_page'], confidence: 0.99 },
  { tiers: ['manual'], confidence: 1 },
];

const VERIFIED_FLOOR = 3;

const RANK = new Map<WebsiteEvidence, number>();
const CONFIDENCE = new Map<WebsiteEvidence, number>();
for (const [rank, rung] of LADDER.entries()) {
  if (rank > 0 && rung.confidence <= LADDER[rank - 1].confidence) {
    throw new Error(
      `Website ladder rung ${rank} (${rung.tiers.join('/')}) has confidence ${rung.confidence}, which does not exceed the rung below it. Stored confidence is what the SQL upgrade guard compares, so it must ascend with rank.`,
    );
  }
  for (const tier of rung.tiers) {
    RANK.set(tier, rank);
    CONFIDENCE.set(tier, rung.confidence);
  }
}

/** Rank of an evidence tier on the upgrade-only ladder. */
export function evidenceRank(evidence: WebsiteEvidence): number {
  return RANK.get(evidence) ?? 0;
}

/** Nominal confidence for an evidence tier. */
export function evidenceConfidence(evidence: WebsiteEvidence): number {
  return CONFIDENCE.get(evidence) ?? 0;
}

/** The status a finding lands in — only `verified` is ever rendered, and
 *  `candidate` is the review backlog. */
export function statusForEvidence(evidence: WebsiteEvidence): WebsiteStatus {
  if (evidence === 'none') return 'none';
  return evidenceRank(evidence) >= VERIFIED_FLOOR ? 'verified' : 'candidate';
}

/** Apply the upgrade-only policy to one company. */
export function decideWebsite(
  existing: ExistingWebsite | null,
  proposed: ProposedWebsite,
): DecideWebsiteResult {
  if (proposed.evidence === 'none' || !proposed.url) return { action: 'keep' };
  if (!existing) return { action: 'update' };

  // Terminal: an owner-set website is never replaced by a discoverer, and a
  // discoverer agreeing with it is not news.
  if (existing.evidence === 'manual' && proposed.evidence !== 'manual') {
    return isSameSite(existing.url, proposed.url)
      ? { action: 'keep' }
      : { action: 'conflict' };
  }

  const eRank = evidenceRank(existing.evidence);
  const pRank = evidenceRank(proposed.evidence);
  if (pRank > eRank) return { action: 'update' };
  if (pRank < eRank) return { action: 'keep' };

  // Same strength, same site: nothing to do.
  if (isSameSite(existing.url, proposed.url)) return { action: 'keep' };

  // Same strength, different site. Which of the two cases this is depends
  // entirely on the source. One source revising the address it published last
  // month is the COMMON case (providers move domains), and treating it as a
  // standoff would freeze the stale value forever, since a demotion to 'dead'
  // never lowers `evidence` and so never lets the correction back in.
  if (existing.source && existing.source === proposed.source) {
    return { action: 'update' };
  }
  // Two different sources naming different sites really is a disagreement, and
  // is surfaced rather than settled by whichever happened to run first.
  return { action: 'conflict' };
}
