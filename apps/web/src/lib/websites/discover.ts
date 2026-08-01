/**
 * Turning a page of search results into a website, or into nothing. No I/O.
 *
 * The verification here is deliberately NOT the one the registry tier uses.
 * A registry candidate arrives with identity already asserted — CQC said "this
 * company's website is X", keyed on the exact company number — so finding the
 * company's name or address on the page corroborates an independent claim.
 *
 * A search candidate has no such claim. We searched the company's NAME, so
 * finding that name on the result is circular: it is why the result came back
 * at all. Only two signals survive that objection, because only two are
 * independent of the query we ran:
 *
 *   - the registered company number on the page (Companies Act 2006 s.82)
 *   - the registered office postcode on the page (the same regulations)
 *
 * Measured on 150 live company sites (2026-08-01): the postcode appears on
 * 59.3%, the number on 28.0%, one or the other on 64.7%. So roughly a third of
 * real company websites cannot be confirmed this way at all, and are correctly
 * discarded rather than guessed at.
 */

import type { WebsiteEvidence } from './decide';

/** What one candidate URL turned out to be, once fetched. */
export type CandidateProbe = {
  url: string;
  /** The company's own registration number was on the page. */
  crnFound: boolean;
  /** The company's registered office postcode was on the page. */
  postcodeFound: boolean;
  /** A directory or profile listing rather than a company's site. */
  onAggregator: boolean;
  /** Parked, for sale, or a holding page. */
  parked: boolean;
};

export type DiscoveryOutcome = {
  url: string | null;
  evidence: WebsiteEvidence;
  /** Which candidate rank won, 1-based. Null when nothing did. */
  rank: number | null;
};

/**
 * How many candidates are worth fetching.
 *
 * Measured, not guessed: over 150 companies whose website we already knew,
 * Serper's recall was 60.0% at rank 1, 76.0% at 3 and 80.7% at 5 — and 80.7%
 * at 10. Recall saturates at five, so every fetch beyond that is spent finding
 * nothing, at roughly a second and a half each across 109,000 companies.
 */
export const MAX_CANDIDATES = 5;

/**
 * Pick the candidate a search result set actually confirms.
 *
 * A registration number wins outright wherever it appears, because it is the
 * company identifying itself and no lower-ranked result can beat that. Failing
 * that, the highest-ranked postcode match wins: rank is the only ordering
 * information the search gave us, so where the evidence ties, position breaks
 * it.
 *
 * Directory listings and holding pages are discarded before either test.
 * Endole, OpenCorporates and the Companies House service all print the
 * registration number on their listing pages, so without that guard the
 * strongest signal here fires hardest on precisely the pages that are not the
 * company's website.
 */
export function decideFromCandidates(
  probes: readonly CandidateProbe[],
): DiscoveryOutcome {
  const usable = probes
    .map((probe, index) => ({ probe, rank: index + 1 }))
    .filter(({ probe }) => !probe.onAggregator && !probe.parked);

  const byNumber = usable.find(({ probe }) => probe.crnFound);
  if (byNumber) {
    return {
      url: byNumber.probe.url,
      evidence: 'crn_on_page',
      rank: byNumber.rank,
    };
  }

  const byAddress = usable.find(({ probe }) => probe.postcodeFound);
  if (byAddress) {
    return {
      url: byAddress.probe.url,
      evidence: 'postcode_on_page',
      rank: byAddress.rank,
    };
  }

  return { url: null, evidence: 'none', rank: null };
}

/** Legal suffixes: no company's website ranks for the word "LIMITED". */
const SUFFIX = /\b(limited|ltd|llp|plc|cic|c\.i\.c)\b\.?/gi;

/**
 * The query to run for one company.
 *
 * The town is appended because UK company names repeat heavily — there are
 * many "Bridge House Care" — and the registered locality is the cheapest
 * disambiguator we hold. Callers should also send the country hint their
 * provider offers (`gl=gb` for Serper): an unlocalised query surfaces the
 * American namesake first, and every company here is UK-registered.
 */
export function buildQuery(companyName: string, town: string): string {
  const name = companyName.replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  return town.trim() ? `${name} ${town.trim()}` : name;
}
