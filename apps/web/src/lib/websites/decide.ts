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
};

export type ProposedWebsite = {
  url: string | null;
  evidence: WebsiteEvidence;
};

export type DecideWebsiteResult =
  | { action: 'update' }
  | { action: 'keep' }
  | { action: 'conflict' };

/** Numeric rank for the upgrade-only ladder. `manual` is terminal: an owner
 *  decision outranks every discoverer and is never overwritten automatically.
 *  The verified/candidate boundary sits at 3 — everything at or above it is
 *  backed by something found on the page or by an exact registry join.
 *
 *  `registry_unconfirmed` ties `llm_adjudicated` (phase5's ladder ties
 *  fuzzy_edit/token_sim the same way): it is a registry row whose own company
 *  name does not recognisably match Companies House. Measured at 0.22% of CQC
 *  joins, and roughly half of those are correct rows whose CH name changed
 *  post-administration ("… REALISATIONS LIMITED"). Too good to discard, not
 *  good enough to render. */
const RANK: Record<WebsiteEvidence, number> = {
  none: 0,
  domain_similarity: 1,
  registry_unconfirmed: 2,
  llm_adjudicated: 2,
  postcode_on_page: 3,
  registry: 4,
  crn_on_page: 5,
  manual: 6,
};

const VERIFIED_FLOOR = 3;

/** Stored confidence is the ladder's numeric proxy, ordered identically to RANK
 *  (ties included), so a writer can enforce upgrade-only in SQL with a plain
 *  `confidence < $new` guard instead of re-deriving the ladder in a query.
 *  Keep it in lockstep with RANK — decide.test.ts locks that they agree. */
const CONFIDENCE: Record<WebsiteEvidence, number> = {
  none: 0,
  domain_similarity: 0.4,
  registry_unconfirmed: 0.6,
  llm_adjudicated: 0.6,
  postcode_on_page: 0.85,
  registry: 0.95,
  crn_on_page: 0.99,
  manual: 1,
};

/** Rank of an evidence tier on the upgrade-only ladder. */
export function evidenceRank(evidence: WebsiteEvidence): number {
  return RANK[evidence] ?? 0;
}

/** Nominal confidence for an evidence tier. */
export function evidenceConfidence(evidence: WebsiteEvidence): number {
  return CONFIDENCE[evidence] ?? 0;
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

  // Same strength. Agreeing is a no-op; disagreeing is surfaced rather than
  // silently resolved by run order — two registries naming different sites for
  // one company means at least one of them is wrong.
  if (isSameSite(existing.url, proposed.url)) return { action: 'keep' };
  return { action: 'conflict' };
}
