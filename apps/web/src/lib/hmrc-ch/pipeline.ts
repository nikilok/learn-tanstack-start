/**
 * Shared HMRC↔Companies House mapping pipeline. Pure functions only — no I/O.
 *
 * Used by:
 *   - apps/web/src/api/companiesHouse.ts (via resolve-sponsor.ts)
 *   - apps/web/scripts/seed-companies-house.ts (via resolve-sponsor.ts)
 *   - apps/web/scripts/phase0a-classify-mappings.ts
 *   - apps/web/scripts/phase0b-resolve-suspects.ts
 *
 * See docs/hmrc-ch-mapping-fix.md for the design rationale and verdict semantics.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants — keep in sync with docs/hmrc-ch-mapping-fix.md
// ─────────────────────────────────────────────────────────────────────────────

export const TIER_C_THRESHOLD = 0.85;
const MIN_TOKENS_FOR_TIER_C = 2;

export const TIER_A2_SCORE = 0.98;
const MIN_SQUASH_LENGTH = 3;

/** Tier D only considers squashed names at least this long — short names give
 *  edit distance nothing to discriminate with. */
const MIN_FUZZY_SQUASH_LENGTH = 9;
/** Squashed names at least this long may differ by 2 edits; shorter ones by 1. */
const FUZZY_LONG_NAME_LENGTH = 16;

/** Patterns that identify statutory public bodies not registered as CH companies. */
const PUBLIC_BODY_REGEX =
  /\b(NHS|National Health Service|Foundation Trust|Integrated Care Board|ICB|(?:Borough|City|County|District|Parish|Town) Council|Reserve Forces|Cadets? Association|Ministry of|Department for|Department of|Office for|Police Federation|Fire and Rescue Service)\b/i;

const STOPWORDS = new Set(['the', 'and', 'of', 'for', 'at', 'in', 'on']);
const CORPORATE_SUFFIXES = new Set(['limited', 'ltd', 'llp', 'plc', 'uk']);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedHmrcName = {
  candidates: string[];
  parsedLegal: string;
  parsedTrading: string | null;
  isPublicBody: boolean;
  /** CH company number embedded in the HMRC name ("(Co Reg: 10843126)" or a
   *  bare trailing 8-digit / 2-letter+6-digit number), normalised to CH form.
   *  The resolver injects this company as a first-class candidate. */
  companyNumberHint: string | null;
};

export type CHCandidate = {
  company_number: string;
  company_name: string;
  company_status: string | null;
  previous_company_names: string[] | null;
  locality: string | null;
  region: string | null;
};

type Tier = 'A' | 'A2' | 'B' | 'C' | 'D';

export type ScoredCandidate = {
  candidate: CHCandidate;
  tier: Tier;
  score: number;
};

export type MatchMethod =
  | 'exact'
  | 'exact_squash'
  | 'previous_name'
  | 'token_sim'
  | 'fuzzy_edit'
  | 'public_body'
  | 'local_replacement_exact'
  | 'local_replacement_previous_name'
  | 'no_match'
  | null;

// ─────────────────────────────────────────────────────────────────────────────
// HMRC name parser
// ─────────────────────────────────────────────────────────────────────────────

// `t\s*\/\s*as?:?` covers T/A, T/As, T/A:, T/ As — all live HMRC variants.
const TA_REGEX = /^(.*?)\s+(?:t\s*\/\s*as?:?|trading\s+as:?|d\/b\/a)\s+(.+)$/i;
const TRADING_NAME_OF_REGEX = /^(.*?)\s+trading\s+name\s+of\s+(.+)$/i;
// "(T/A Chop Wok)", "(Trading as Subway)", "(ta Bluebird Care)" tails.
const PARENS_TA_REGEX =
  /^(.*?)\s*\(\s*(?:t\s*\/\s*as?:?|trading\s+as:?|ta)\s+([^)]+)\)\s*$/i;
// Bare "TA" needs a corporate suffix anchor before it ("… LTD TA Maharanis")
// or it would fire on names that legitimately contain the word.
const SUFFIX_TA_REGEX = /^(.*?\b(?:limited|ltd|plc|llp)\b\.?),?\s+ta\s+(.+)$/i;
const CO_TAIL_REGEX = /^(.*?),?\s+c\/o\s+.+$/i;
const BRANCH_REGEX =
  /^(.*?)\s*(?:\([^)]*Branch[^)]*\)|\bUK\s+Branch\b|\bUK\s+Establishment\b)\s*$/i;
// "(Co Reg: 10843126)", "(Company No. SC123456)" — and, separately, a bare
// trailing 8-digit or 2-letter+6-digit company number.
const REG_NUMBER_PARENS_REGEX =
  /\s*\(\s*(?:co\.?|company|reg(?:istration)?)[\s.:]*(?:reg(?:istration)?|no\.?|number)?[\s.:]*([a-z]{2}\d{6}|\d{6,8})\s*\)\s*/i;
const REG_NUMBER_TRAILING_REGEX = /\s+([a-z]{2}\d{6}|\d{8})\s*$/i;

/** Pads bare numeric company numbers to CH's zero-filled 8-digit form. */
function normaliseCompanyNumber(raw: string): string {
  const upper = raw.toUpperCase();
  return /^\d+$/.test(upper) ? upper.padStart(8, '0') : upper;
}

/**
 * Parses an HMRC organisation name into ordered (legal, trading) candidates.
 * Handles `T/A` (and its `T/As` / `T/A:` / bare-`TA`-after-suffix /
 * parenthesised variants), `Trading As`, `d/b/a`, `Trading name of`
 * (inverted), `C/O …` tails, branch suffixes, and embedded company-number
 * decorations (extracted into `companyNumberHint` and stripped). Internal
 * whitespace is collapsed. Also flags public-body matches via
 * PUBLIC_BODY_REGEX.
 */
export function parseHmrcName(orgName: string): ParsedHmrcName {
  const collapsed = orgName.replace(/\s+/g, ' ').trim();
  const isPublicBody = PUBLIC_BODY_REGEX.test(collapsed);

  let working = collapsed;
  let companyNumberHint: string | null = null;
  const parensReg = working.match(REG_NUMBER_PARENS_REGEX);
  if (parensReg) {
    companyNumberHint = normaliseCompanyNumber(parensReg[1]);
    working = working
      .replace(REG_NUMBER_PARENS_REGEX, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    const trailingReg = working.match(REG_NUMBER_TRAILING_REGEX);
    if (trailingReg) {
      companyNumberHint = normaliseCompanyNumber(trailingReg[1]);
      working = working.replace(REG_NUMBER_TRAILING_REGEX, '').trim();
    }
  }

  const withTrading = (legal: string, trading: string): ParsedHmrcName => ({
    candidates: [legal, trading],
    parsedLegal: legal,
    parsedTrading: trading,
    isPublicBody,
    companyNumberHint,
  });
  const legalOnly = (legal: string): ParsedHmrcName => ({
    candidates: [legal],
    parsedLegal: legal,
    parsedTrading: null,
    isPublicBody,
    companyNumberHint,
  });

  const tradingNameOf = working.match(TRADING_NAME_OF_REGEX);
  if (tradingNameOf) {
    return withTrading(tradingNameOf[2].trim(), tradingNameOf[1].trim());
  }

  const parensTa = working.match(PARENS_TA_REGEX);
  if (parensTa) return withTrading(parensTa[1].trim(), parensTa[2].trim());

  const ta = working.match(TA_REGEX);
  if (ta) return withTrading(ta[1].trim(), ta[2].trim());

  const suffixTa = working.match(SUFFIX_TA_REGEX);
  if (suffixTa) return withTrading(suffixTa[1].trim(), suffixTa[2].trim());

  const coTail = working.match(CO_TAIL_REGEX);
  if (coTail) return legalOnly(coTail[1].trim());

  const branch = working.match(BRANCH_REGEX);
  if (branch) return legalOnly(branch[1].trim());

  return legalOnly(working);
}

/** Convenience: returns just the legal candidate string for callers that don't need full parse. */
export function parseLegalCandidate(orgName: string): string {
  return parseHmrcName(orgName).parsedLegal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison helpers
// ─────────────────────────────────────────────────────────────────────────────

const SUFFIX_STRIP_REGEX = /\s+(LIMITED|LTD|LLP|PLC)\.?\s*$/i;
/** Squash-tier suffix strip — also eats a comma/period joining the suffix
 *  ("Leaf.fm, ltd", "CAREL U.K. LTD."). */
const SQUASH_SUFFIX_REGEX = /[\s,.]+(LIMITED|LTD|LLP|PLC)\.?,?\s*$/i;
const TOKEN_SPLIT_REGEX = /[\s,&\-./()]+/;
const TRADING_AS_IN_PREV_REGEX = /(TRADING\s+AS|T\/A|D\/B\/A)/i;
const SMART_QUOTES_REGEX = /[‘’`´]/g;
const NON_ALNUM_REGEX = /[^A-Z0-9]/g;

/** Uppercases, folds curly quotes, collapses whitespace, and strips the
 *  trailing corporate suffix for direct equality checks. */
export function normaliseForComparison(name: string): string {
  return name
    .replace(SMART_QUOTES_REGEX, "'")
    .replace(/\s+/g, ' ')
    .replace(SUFFIX_STRIP_REGEX, '')
    .trim()
    .toUpperCase();
}

/**
 * Aggressive comparison key: accent-fold (NFKD), strip a trailing corporate
 * suffix (tolerating ", ltd" / "LTD." forms), then drop every remaining
 * non-alphanumeric. CH's own company-name uniqueness rules treat punctuation,
 * case, and spacing variants as "the same name", so equality on this key is
 * near-exact evidence ("J S B HAULAGE LIMITED" ≡ "JSB Haulage LTD").
 */
export function squashForComparison(name: string): string {
  return name
    .normalize('NFKD')
    .toUpperCase()
    .replace(SQUASH_SUFFIX_REGEX, '')
    .replace(NON_ALNUM_REGEX, '');
}

/** Lowercases, splits, drops stopwords + corporate suffixes for Jaccard comparison. */
function tokenise(name: string): string[] {
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
function jaccard(a: string[], b: string[]): number {
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

/** Tier A2: squash-key equality — names identical up to punctuation, spacing,
 *  accents, and suffix form. Guarded by MIN_SQUASH_LENGTH so degenerate keys
 *  (non-Latin names squash to '') can never claim equality. */
export function matchTierASquash(
  candidate: string,
  ch: CHCandidate,
): number | null {
  const a = squashForComparison(candidate);
  const b = squashForComparison(ch.company_name);
  if (a.length < MIN_SQUASH_LENGTH || b.length < MIN_SQUASH_LENGTH) return null;
  return a === b ? TIER_A2_SCORE : null;
}

/** Optimal-string-alignment edit distance (Levenshtein + adjacent
 *  transposition), bounded: returns max+1 as soon as the distance exceeds
 *  `max`, and short-circuits on the length gap alone. */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
      if (dp[i][j] < rowMin) rowMin = dp[i][j];
    }
    if (rowMin > max) return max + 1;
  }
  return Math.min(dp[a.length][b.length], max + 1);
}

/** Squash variant that keeps the corporate suffix — used by Tier D so a
 *  typo'd suffix ("LIMTIED"), which the stripper cannot recognise, is
 *  distance-matched against the other side's intact suffix instead of
 *  producing wildly different key lengths. */
function squashKeepingSuffix(name: string): string {
  return name.normalize('NFKD').toUpperCase().replace(NON_ALNUM_REGEX, '');
}

/** Distance ≤ 1 (≤ 2 for long keys) or null. Shared by both Tier D passes. */
function fuzzyScore(a: string, b: string): number | null {
  const max = Math.min(a.length, b.length) >= FUZZY_LONG_NAME_LENGTH ? 2 : 1;
  const dist = boundedEditDistance(a, b, max);
  if (dist > max) return null;
  return 0.92 - dist * 0.02;
}

/**
 * Tier D: near-miss typo match — squashed edit distance ≤ 1 (≤ 2 for long
 * names) on names long enough to discriminate. Catches "LLYODS"→"LLOYDS",
 * "MADANI"→"MADNI", "LIMTIED"→"LIMITED"-class HMRC typos. Compared twice:
 * suffix-stripped, then suffix-retained (for typo'd suffixes the stripper
 * can't see). Name evidence this weak is only accepted by the resolver for
 * ACTIVE candidates whose locality corroborates (see matchesHmrcLocality) —
 * do not use it unguarded.
 */
export function matchTierD(candidate: string, ch: CHCandidate): number | null {
  const a = squashForComparison(candidate);
  const b = squashForComparison(ch.company_name);
  if (a.length < MIN_FUZZY_SQUASH_LENGTH || b.length < MIN_FUZZY_SQUASH_LENGTH)
    return null;
  if (a === b) return null; // squash equality is Tier A2's claim

  const stripped = fuzzyScore(a, b);
  if (stripped !== null) return stripped;

  const aKeep = squashKeepingSuffix(candidate);
  const bKeep = squashKeepingSuffix(ch.company_name);
  if (aKeep === a && bKeep === b) return null; // no suffix on either side
  return fuzzyScore(aKeep, bKeep);
}

/** Case-insensitive match of a candidate's locality/region against the HMRC
 *  sponsor's town/county — the corroboration gate for Tier D. */
export function matchesHmrcLocality(
  ch: CHCandidate,
  hmrcTown: string | null,
  hmrcCounty: string | null,
): boolean {
  const loc = (ch.locality ?? '').trim().toUpperCase();
  const reg = (ch.region ?? '').trim().toUpperCase();
  const town = (hmrcTown ?? '').trim().toUpperCase();
  const county = (hmrcCounty ?? '').trim().toUpperCase();
  if (!loc && !reg) return false;
  if (town && (loc === town || reg === town)) return true;
  return Boolean(county && (loc === county || reg === county));
}

/**
 * Pre-search cleanup: accent-fold to ASCII, fold curly quotes, replace the
 * punctuation CH's search chokes on (`+ . , /`) with spaces, drop remaining
 * non-ASCII (mojibake artefacts), collapse whitespace. Tier comparisons still
 * run against the raw legal candidate — this only shapes the query string.
 */
export function normaliseSearchQuery(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(SMART_QUOTES_REGEX, "'")
    .replace(/[“”]/g, '"')
    .replace(/[+.,/?]/g, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * Picks the best candidate by lexical score first, then locality match against
 * the HMRC sponsor's town/county as tiebreak (+2 town/city, +1 county). Score
 * always wins over locality so a Tier-A exact match in the wrong town beats a
 * Tier-C threshold match in the right town. Returns 'tied' if no unique winner.
 */
export function pickByLocality(
  candidates: ScoredCandidate[],
  hmrcTown: string | null,
  hmrcCounty: string | null,
): ScoredCandidate | 'tied' {
  if (candidates.length === 1) return candidates[0];

  const bestScore = Math.max(...candidates.map((c) => c.score));
  const topScored = candidates.filter((c) => c.score === bestScore);
  if (topScored.length === 1) return topScored[0];

  if (!hmrcTown && !hmrcCounty) return 'tied';

  const hmrcTownU = hmrcTown?.toUpperCase() ?? '';
  const hmrcCountyU = hmrcCounty?.toUpperCase() ?? '';

  const scored = topScored.map((c) => {
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
