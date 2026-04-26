/**
 * Shared HMRC↔Companies House mapping pipeline. Pure functions only — no I/O.
 *
 * Used by:
 *   - apps/web/scripts/phase0a-classify-mappings.ts
 *   - apps/web/scripts/phase0b-resolve-suspects.ts
 *   - apps/web/scripts/seed-companies-house.ts
 *
 * See docs/hmrc-ch-mapping-fix.md for the design rationale and verdict semantics.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants — keep in sync with docs/hmrc-ch-mapping-fix.md
// ─────────────────────────────────────────────────────────────────────────────

export const TIER_C_THRESHOLD = 0.85;
export const MIN_TOKENS_FOR_TIER_C = 2;

/** Patterns that identify statutory public bodies not registered as CH companies. */
export const PUBLIC_BODY_REGEX =
  /\b(NHS|National Health Service|Foundation Trust|Integrated Care Board|ICB|(?:Borough|City|County|District|Parish|Town) Council|Reserve Forces|Cadets? Association|Ministry of|Department for|Department of|Office for|Police Federation|Fire and Rescue Service)\b/i;

export const STOPWORDS = new Set(['the', 'and', 'of', 'for', 'at', 'in', 'on']);
export const CORPORATE_SUFFIXES = new Set([
  'limited',
  'ltd',
  'llp',
  'plc',
  'uk',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedHmrcName = {
  candidates: string[];
  parsedLegal: string;
  parsedTrading: string | null;
  isPublicBody: boolean;
};

export type CHCandidate = {
  company_number: string;
  company_name: string;
  company_status: string | null;
  previous_company_names: string[] | null;
  locality: string | null;
  region: string | null;
};

export type Tier = 'A' | 'B' | 'C';

export type ScoredCandidate = {
  candidate: CHCandidate;
  tier: Tier;
  score: number;
};

export type MatchMethod =
  | 'exact'
  | 'previous_name'
  | 'token_sim'
  | 'public_body'
  | 'local_replacement_exact'
  | 'local_replacement_previous_name'
  | 'no_match'
  | null;

// ─────────────────────────────────────────────────────────────────────────────
// HMRC name parser
// ─────────────────────────────────────────────────────────────────────────────

const TA_REGEX =
  /^(.*?)\s+(?:T\/A|t\/a|Trading\s+[Aa]s:?|d\/b\/a|D\/B\/A)\s+(.+)$/;
const TRADING_NAME_OF_REGEX = /^(.*?)\s+Trading\s+[Nn]ame\s+of\s+(.+)$/;
const BRANCH_REGEX =
  /^(.*?)\s*(?:\([^)]*Branch[^)]*\)|\bUK\s+Branch\b|\bUK\s+Establishment\b)\s*$/i;

/**
 * Parses an HMRC organisation name into ordered (legal, trading) candidates.
 * Handles `T/A`, `Trading As`, `d/b/a`, `Trading name of` (inverted), and
 * branch suffixes. Also flags public-body matches via PUBLIC_BODY_REGEX.
 */
export function parseHmrcName(orgName: string): ParsedHmrcName {
  const trimmed = orgName.trim();
  const isPublicBody = PUBLIC_BODY_REGEX.test(trimmed);

  const tradingNameOf = trimmed.match(TRADING_NAME_OF_REGEX);
  if (tradingNameOf) {
    const trading = tradingNameOf[1].trim();
    const legal = tradingNameOf[2].trim();
    return {
      candidates: [legal, trading],
      parsedLegal: legal,
      parsedTrading: trading,
      isPublicBody,
    };
  }

  const ta = trimmed.match(TA_REGEX);
  if (ta) {
    const legal = ta[1].trim();
    const trading = ta[2].trim();
    return {
      candidates: [legal, trading],
      parsedLegal: legal,
      parsedTrading: trading,
      isPublicBody,
    };
  }

  const branch = trimmed.match(BRANCH_REGEX);
  if (branch) {
    const legal = branch[1].trim();
    return {
      candidates: [legal],
      parsedLegal: legal,
      parsedTrading: null,
      isPublicBody,
    };
  }

  return {
    candidates: [trimmed],
    parsedLegal: trimmed,
    parsedTrading: null,
    isPublicBody,
  };
}

/** Convenience: returns just the legal candidate string for callers that don't need full parse. */
export function parseLegalCandidate(orgName: string): string {
  return parseHmrcName(orgName).parsedLegal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison helpers
// ─────────────────────────────────────────────────────────────────────────────

const SUFFIX_STRIP_REGEX = /\s+(LIMITED|LTD|LLP|PLC)\.?\s*$/i;
const TOKEN_SPLIT_REGEX = /[\s,&\-./()]+/;
const TRADING_AS_IN_PREV_REGEX = /(TRADING\s+AS|T\/A|D\/B\/A)/i;

/** Uppercases and strips trailing corporate suffix for direct equality checks. */
export function normaliseForComparison(name: string): string {
  return name.replace(SUFFIX_STRIP_REGEX, '').trim().toUpperCase();
}

/** Lowercases, splits, drops stopwords + corporate suffixes for Jaccard comparison. */
export function tokenise(name: string): string[] {
  return name
    .toLowerCase()
    .split(TOKEN_SPLIT_REGEX)
    .filter(
      (t) =>
        t.length > 0 &&
        !STOPWORDS.has(t) &&
        !CORPORATE_SUFFIXES.has(t) &&
        /[a-z0-9]/.test(t),
    );
}

/** Jaccard similarity over two token sets. Returns 0 for empty inputs. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Tier A: exact name match (after suffix strip + uppercase). */
export function matchTierA(candidate: string, ch: CHCandidate): number | null {
  return normaliseForComparison(candidate) ===
    normaliseForComparison(ch.company_name)
    ? 1.0
    : null;
}

/**
 * Tier B: candidate appears verbatim in `previous_company_names`, ignoring
 * entries that themselves contain TRADING AS / T/A / D/B/A. The exclusion
 * guards against the brand-name-as-previous-name trap (e.g. "A CLASS FOOD
 * TRADING AS ROOSTERS PIRI PIRI LIMITED" being indexed by CH).
 */
export function matchTierB(candidate: string, ch: CHCandidate): number | null {
  if (!ch.previous_company_names || ch.previous_company_names.length === 0)
    return null;
  const c = normaliseForComparison(candidate);
  for (const prev of ch.previous_company_names) {
    if (TRADING_AS_IN_PREV_REGEX.test(prev)) continue;
    if (normaliseForComparison(prev) === c) return 0.95;
  }
  return null;
}

/**
 * Tier C: token-set Jaccard similarity above TIER_C_THRESHOLD. Both sides
 * must retain at least MIN_TOKENS_FOR_TIER_C tokens after stripping to avoid
 * spurious matches on very short names.
 */
export function matchTierC(candidate: string, ch: CHCandidate): number | null {
  const tA = tokenise(candidate);
  const tB = tokenise(ch.company_name);
  if (tA.length < MIN_TOKENS_FOR_TIER_C || tB.length < MIN_TOKENS_FOR_TIER_C)
    return null;
  const score = jaccard(tA, tB);
  return score >= TIER_C_THRESHOLD ? score : null;
}

/**
 * Picks the best candidate by locality match against the HMRC sponsor's
 * town/county. +2 for town/city match, +1 for county match. Returns 'tied'
 * if no unique winner.
 */
export function pickByLocality(
  candidates: ScoredCandidate[],
  hmrcTown: string | null,
  hmrcCounty: string | null,
): ScoredCandidate | 'tied' {
  if (candidates.length === 1) return candidates[0];
  if (!hmrcTown && !hmrcCounty) return 'tied';

  const hmrcTownU = hmrcTown?.toUpperCase() ?? '';
  const hmrcCountyU = hmrcCounty?.toUpperCase() ?? '';

  const scored = candidates.map((c) => {
    const locU = (c.candidate.locality ?? '').toUpperCase();
    const regU = (c.candidate.region ?? '').toUpperCase();
    let s = 0;
    if (hmrcTownU && (locU === hmrcTownU || regU === hmrcTownU)) s += 2;
    if (hmrcCountyU && (locU === hmrcCountyU || regU === hmrcCountyU)) s += 1;
    return { ...c, localityScore: s };
  });

  const max = Math.max(...scored.map((s) => s.localityScore));
  if (max === 0) return 'tied';
  const winners = scored.filter((s) => s.localityScore === max);
  return winners.length === 1 ? winners[0] : 'tied';
}
