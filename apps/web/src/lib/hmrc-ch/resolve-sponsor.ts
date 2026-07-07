/**
 * resolveOneSponsor — runs the full HMRC↔CH verification pipeline for a
 * single sponsor name and returns the resolved CH entity (or a fail-closed
 * verdict). The caller injects `fetchApi`, so they own auth, rate-limiting,
 * caching, and retry policy.
 *
 * Used by:
 *   - apps/web/src/api/companiesHouse.ts (on-demand resolver, Phase 3)
 *   - apps/web/scripts/seed-companies-house.ts (one-time bootstrap)
 *   - phase0b can be refactored to use this once its current run completes
 *
 * Pipeline (see docs/hmrc-ch-mapping-fix.md for rationale):
 *   1. Parse organisation name → legal candidate + public-body flag +
 *      embedded company-number hint
 *   2. Public-body short-circuit (skip CH lookup entirely)
 *   3. Search CH with the LEGAL candidate only (Policy A — never trading-name),
 *      through normaliseSearchQuery; inject the hinted company (if any) as a
 *      first-class candidate
 *   4. Tier A across all candidates → exact name match
 *   5. If no active Tier A: Tier A2 (squash-key equality — punctuation/spacing/
 *      suffix-form variants)
 *   6. If no active A/A2: fetch top-N profiles, try Tier B (clean previous-name)
 *   7. If no active A/A2/B: Tier C across all candidates (token-set Jaccard)
 *   8. If nothing active yet: Tier D (squashed edit distance ≤ 1-2) — ACTIVE
 *      candidates with corroborating locality only, no inactive fallback
 *   9. Locality tiebreak when multiple candidates pass at the same tier
 *  10. Fail closed if no verified match
 */

import {
  type CHCandidate,
  matchesHmrcLocality,
  matchTierA,
  matchTierASquash,
  matchTierB,
  matchTierC,
  matchTierD,
  normaliseSearchQuery,
  parseHmrcName,
  pickByLocality,
  type ScoredCandidate,
} from './pipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type CHSearchItem = {
  company_number: string;
  title: string;
  company_status?: string;
  address?: { locality?: string; region?: string };
  matches?: Record<string, unknown>;
};

type CHSearchResponse = { items?: CHSearchItem[] } | null;

type CHFullProfile = {
  company_number: string;
  company_name: string;
  company_status?: string;
  type?: string;
  date_of_creation?: string;
  registered_office_address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
  sic_codes?: string[];
  accounts?: {
    next_made_up_to?: string;
    last_accounts?: { made_up_to?: string };
    overdue?: boolean;
  };
  jurisdiction?: string;
  has_been_liquidated?: boolean;
  has_insolvency_history?: boolean;
  has_charges?: boolean;
  previous_company_names?: { name: string }[];
  confirmation_statement?: { last_made_up_to?: string };
};

export type FetchApi = (path: string) => Promise<unknown | null>;

export type HmrcLocation = {
  townCity?: string | null;
  county?: string | null;
};

export type ResolveResult =
  | {
      verdict: 'verified';
      companyNumber: string;
      matchMethod:
        | 'exact'
        | 'exact_squash'
        | 'previous_name'
        | 'token_sim'
        | 'fuzzy_edit';
      matchScore: number;
      queryUsed: string;
      profile: CHFullProfile;
    }
  | { verdict: 'public_body'; reason: 'matched_public_body_regex' }
  | {
      verdict: 'no_match';
      queryUsed: string;
      topResults: CHSearchItem[];
    }
  | {
      verdict: 'human_review';
      queryUsed: string;
      contenders: ScoredCandidate[];
      topResults: CHSearchItem[];
    };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SEARCH_PAGE_SIZE = 20;
const DEFAULT_TIER_B_TOP_N = 3;

function searchItemToCandidate(item: CHSearchItem): CHCandidate {
  return {
    company_number: item.company_number,
    company_name: item.title,
    company_status: item.company_status ?? null,
    previous_company_names: null,
    locality: item.address?.locality ?? null,
    region: item.address?.region ?? null,
  };
}

function profileToCandidate(p: CHFullProfile): CHCandidate {
  return {
    company_number: p.company_number,
    company_name: p.company_name,
    company_status: p.company_status ?? null,
    previous_company_names:
      p.previous_company_names?.map((x) => x.name) ?? null,
    locality: p.registered_office_address?.locality ?? null,
    region: p.registered_office_address?.region ?? null,
  };
}

/** Treat only `company_status === 'active'` as operationally live. Dissolved,
 *  liquidation, closed, converted-closed, removed, and missing/null status are
 *  all treated as inactive — used by the resolver to prefer live entities over
 *  similarly-named dissolved namesakes. See "Active-status preference" below. */
function isActive(s: string | null | undefined): boolean {
  return s === 'active';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a single HMRC organisation name to a verified CH company. Returns
 * a verdict object — never an exception for "no match" cases. Caller decides
 * what to do with each verdict (insert / skip / queue for review / etc.).
 *
 * The function may fetch up to 1 embedded-number profile + 1 search + 3
 * profile lookups during scoring, then 1 additional profile fetch only if
 * the verified candidate's profile isn't already in hand.
 */
export async function resolveOneSponsor(
  orgName: string,
  hmrcLocation: HmrcLocation,
  fetchApi: FetchApi,
  options?: {
    searchPageSize?: number;
    tierBTopN?: number;
  },
): Promise<ResolveResult> {
  const searchPageSize = options?.searchPageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  const tierBTopN = options?.tierBTopN ?? DEFAULT_TIER_B_TOP_N;

  const parsed = parseHmrcName(orgName);
  if (parsed.isPublicBody) {
    return { verdict: 'public_body', reason: 'matched_public_body_regex' };
  }

  const legal = parsed.parsedLegal;
  // Comparisons run against the raw legal candidate; only the query string is
  // normalised (punctuation like "+", ".", "," makes CH search return junk or
  // nothing at all — "Leaf.fm, ltd", "Landis+Gyr").
  const searchQuery = normaliseSearchQuery(legal) || legal;

  const search = (await fetchApi(
    `/search/companies?q=${encodeURIComponent(searchQuery)}&items_per_page=${searchPageSize}`,
  )) as CHSearchResponse;
  const items = search?.items ?? [];
  const topResults = items.slice(0, 5);

  const profilesByNumber = new Map<string, CHFullProfile>();

  // Candidate pool: search results, plus — when the HMRC name embeds a
  // company number — that company injected as a first-class candidate. It
  // competes through the normal tiers, so a bogus embedded number just loses.
  const candidates: CHCandidate[] = items.map(searchItemToCandidate);
  if (parsed.companyNumberHint) {
    const hinted = (await fetchApi(
      `/company/${encodeURIComponent(parsed.companyNumberHint)}`,
    )) as CHFullProfile | null;
    if (hinted) {
      profilesByNumber.set(hinted.company_number, hinted);
      const rest = candidates.filter(
        (c) => c.company_number !== hinted.company_number,
      );
      candidates.length = 0;
      candidates.push(profileToCandidate(hinted), ...rest);
    }
  }

  if (candidates.length === 0) {
    return { verdict: 'no_match', queryUsed: searchQuery, topResults };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Active-status preference
  //
  // Pre-fix bug: a Tier-A match on a *dissolved* namesake (e.g. CH search
  // returns `3DC LIMITED` dissolved at company_number X) would short-circuit
  // and beat a Tier-B match on the *active* renamed entity (`SHOP3D LTD` whose
  // previous_company_names contains `3DC LTD`). The downstream `decide()`
  // upgrade-only policy treats Tier A as strictly stronger than Tier B/C, so
  // an inactive Tier-A match would silently overwrite an active Tier-B
  // mapping during a Phase 5 sweep.
  //
  // Fix: scan all three tiers, partition each by active vs. inactive, and
  // prefer active matches at the strongest tier. Only fall back to inactive
  // matches when no tier produced any active match — this preserves the
  // "sponsor's company has actually wound up" path while killing the
  // dissolved-namesake trap.
  // ───────────────────────────────────────────────────────────────────────

  const tierA: ScoredCandidate[] = [];
  for (const cand of candidates) {
    const a = matchTierA(legal, cand);
    if (a !== null) tierA.push({ candidate: cand, tier: 'A', score: a });
  }
  const tierAActive = tierA.filter((s) => isActive(s.candidate.company_status));

  // Tier A2 — squash-key equality (punctuation / spacing / suffix-form
  // variants of the same name). Scanned only when Tier A found no active
  // match, mirroring the active-status preference cascade below.
  const tierA2: ScoredCandidate[] = [];
  if (tierAActive.length === 0) {
    for (const cand of candidates) {
      const a2 = matchTierASquash(legal, cand);
      if (a2 !== null) tierA2.push({ candidate: cand, tier: 'A2', score: a2 });
    }
  }
  const tierA2Active = tierA2.filter((s) =>
    isActive(s.candidate.company_status),
  );

  const tierB: ScoredCandidate[] = [];
  if (tierAActive.length === 0 && tierA2Active.length === 0) {
    for (const shallow of candidates.slice(0, tierBTopN)) {
      const profile =
        profilesByNumber.get(shallow.company_number) ??
        ((await fetchApi(
          `/company/${encodeURIComponent(shallow.company_number)}`,
        )) as CHFullProfile | null);
      if (!profile) continue;
      profilesByNumber.set(profile.company_number, profile);
      const cand = profileToCandidate(profile);
      const b = matchTierB(legal, cand);
      if (b !== null) tierB.push({ candidate: cand, tier: 'B', score: b });
    }
  }
  const tierBActive = tierB.filter((s) => isActive(s.candidate.company_status));

  const tierC: ScoredCandidate[] = [];
  if (
    tierAActive.length === 0 &&
    tierA2Active.length === 0 &&
    tierBActive.length === 0
  ) {
    for (const cand of candidates) {
      const c = matchTierC(legal, cand);
      if (c !== null) tierC.push({ candidate: cand, tier: 'C', score: c });
    }
  }
  const tierCActive = tierC.filter((s) => isActive(s.candidate.company_status));

  // Tier D — typo-distance matches. Name evidence this weak is only accepted
  // for ACTIVE candidates whose locality corroborates the HMRC town/county;
  // there is deliberately no inactive or unconfirmed fallback.
  const tierD: ScoredCandidate[] = [];
  if (
    tierAActive.length === 0 &&
    tierA2Active.length === 0 &&
    tierBActive.length === 0 &&
    tierCActive.length === 0
  ) {
    for (const cand of candidates) {
      if (!isActive(cand.company_status)) continue;
      if (
        !matchesHmrcLocality(
          cand,
          hmrcLocation.townCity ?? null,
          hmrcLocation.county ?? null,
        )
      ) {
        continue;
      }
      const d = matchTierD(legal, cand);
      if (d !== null) tierD.push({ candidate: cand, tier: 'D', score: d });
    }
  }

  // Prefer active at the strongest tier; fall back to inactive only when no
  // tier produced any active candidate (Tier D never has an inactive pool).
  let acceptedTier: ScoredCandidate[];
  if (tierAActive.length > 0) acceptedTier = tierAActive;
  else if (tierA2Active.length > 0) acceptedTier = tierA2Active;
  else if (tierBActive.length > 0) acceptedTier = tierBActive;
  else if (tierCActive.length > 0) acceptedTier = tierCActive;
  else if (tierD.length > 0) acceptedTier = tierD;
  else if (tierA.length > 0) acceptedTier = tierA;
  else if (tierA2.length > 0) acceptedTier = tierA2;
  else if (tierB.length > 0) acceptedTier = tierB;
  else acceptedTier = tierC;

  if (acceptedTier.length === 0) {
    return { verdict: 'no_match', queryUsed: searchQuery, topResults };
  }

  const picked = pickByLocality(
    acceptedTier,
    hmrcLocation.townCity ?? null,
    hmrcLocation.county ?? null,
  );

  if (picked === 'tied') {
    return {
      verdict: 'human_review',
      queryUsed: searchQuery,
      contenders: acceptedTier.slice(0, 5),
      topResults,
    };
  }

  const verifiedNumber = picked.candidate.company_number;
  let verifiedProfile = profilesByNumber.get(verifiedNumber);
  if (!verifiedProfile) {
    const fetched = (await fetchApi(
      `/company/${encodeURIComponent(verifiedNumber)}`,
    )) as CHFullProfile | null;
    if (!fetched) {
      return { verdict: 'no_match', queryUsed: searchQuery, topResults };
    }
    verifiedProfile = fetched;
  }

  return {
    verdict: 'verified',
    companyNumber: verifiedNumber,
    matchMethod:
      picked.tier === 'A'
        ? 'exact'
        : picked.tier === 'A2'
          ? 'exact_squash'
          : picked.tier === 'B'
            ? 'previous_name'
            : picked.tier === 'D'
              ? 'fuzzy_edit'
              : 'token_sim',
    matchScore: picked.score,
    queryUsed: searchQuery,
    profile: verifiedProfile,
  };
}
