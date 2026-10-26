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
 * The name still has one use: a postcode is an address, and a site at that
 * address that never names the company is another business there. So the
 * name is required beside the postcode (company-naming.ts), never enough alone.
 *
 * Measured on 150 live company sites (2026-08-01): the postcode appears on
 * 59.3%, the number on 28.0%, one or the other on 64.7%. So roughly a third of
 * real company websites cannot be confirmed this way at all, and are correctly
 * discarded rather than guessed at.
 */

import { isDiscoveryAggregator } from './crowded-hosts';
import type { WebsiteEvidence } from './decide';
import type { PageRead } from './name-and-place';
import type { StatedOnSite } from './stated-numbers';

/** What one candidate site turned out to be, once fetched. */
export type CandidateProbe = {
  /** The site ORIGIN, which is what gets stored and rendered. */
  url: string;
  /** The page the proof was actually found on: the origin, or a disclosure
   *  path one click away. Null when nothing was proven. */
  evidenceUrl: string | null;
  /** The company's own registration number was on the page. */
  crnFound: boolean;
  /** The company's registered office postcode was on the page. */
  postcodeFound: boolean;
  /** The postcode was read on a page that names the company as its own: by the host that served it, or in its text, never as a listing's entry. */
  postcodeNamed?: boolean;
  /** A directory or profile listing rather than a company's site. */
  onAggregator: boolean;
  /** Parked, for sale, or a holding page. */
  parked: boolean;
  /** The homepage is a bot challenge, not the site. */
  challenged?: boolean;
  /** Same-site pages the homepage links to; none means a menu its scripts build. */
  siteLinks?: number;
  /** The homepage carries too little text to have been read. */
  thin?: boolean;
  /** Same-site legal pages the homepage links to, walked before the fixed paths. */
  legalLinks?: string[];
  /** Same-site about and team pages the homepage links to, walked after the fixed paths. */
  aboutLinks?: string[];
  /** Statutory company numbers the pages read for this candidate stated. */
  stated?: StatedOnSite[];
  /** The pages read so far, homepage first, as the two-signal rule reads them. */
  pages?: PageRead[];
};

export type DiscoveryOutcome = {
  url: string | null;
  /** Where the proof was read. Stored alongside the URL so a later pass can
   *  see which page carried the number rather than re-deriving it. */
  evidenceUrl: string | null;
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
 * that, the highest-ranked postcode match on a site that names the company
 * wins: rank is the only ordering information the search gave us, so where
 * the evidence ties, position breaks it.
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
      evidenceUrl: byNumber.probe.evidenceUrl,
      evidence: 'crn_on_page',
      rank: byNumber.rank,
    };
  }

  // A postcode is an address, so it proves the site only where the site also
  // names the company: otherwise it is another business at the same address.
  const byAddress = usable.find(
    ({ probe }) => probe.postcodeFound && probe.postcodeNamed,
  );
  if (byAddress) {
    return {
      url: byAddress.probe.url,
      evidenceUrl: byAddress.probe.evidenceUrl,
      evidence: 'postcode_on_page',
      rank: byAddress.rank,
    };
  }

  return { url: null, evidenceUrl: null, evidence: 'none', rank: null };
}

/**
 * Search results reduced to the sites they belong to, in rank order.
 *
 * A result is usually a deep page, and a deep page is neither what a visitor
 * should be sent to nor where a company states who it is — ownership is on the
 * homepage, the registration number on a legal page. Several results also
 * frequently share one site, so deduping here removes fetches rather than
 * adding them.
 */
export function candidateOrigins(urls: readonly string[]): string[] {
  const origins: string[] = [];
  for (const raw of urls) {
    let origin: string;
    try {
      origin = new URL(raw).origin;
    } catch {
      continue;
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** Candidate origins without directories, so none of them takes a slot. */
export function siteOrigins(
  urls: readonly string[],
  crowded: ReadonlySet<string>,
): string[] {
  return candidateOrigins(urls).filter((origin) => {
    // A non-web result's origin is the string "null", which no fetch can use.
    if (!/^https?:\/\//.test(origin)) return false;
    return !isDiscoveryAggregator(new URL(origin).hostname, crowded);
  });
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
