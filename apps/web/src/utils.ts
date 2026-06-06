const UPPERCASE_WORDS = new Set([
  'uk',
  'us',
  'usa',
  'eu',
  'llp',
  'plc',
  'ltd',
  'llc',
  'cic',
]);

/**
 * Convert a string to title case, but force known acronyms (UK, USA, LLP,
 * PLC, etc.) to all-uppercase. Returns an empty string for `null`/empty
 * input — used to clean up HMRC organisation names for display.
 */
export function titleCase(str: string | null) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(
      /\b(\d*)([a-z])/g,
      (_, digits, letter) => digits + letter.toUpperCase(),
    )
    .replace(/\b\w+\b/g, (word) =>
      UPPERCASE_WORDS.has(word.toLowerCase()) ? word.toUpperCase() : word,
    );
}

/**
 * Lowercase and replace runs of non-alphanumeric characters with `-`,
 * trimming leading/trailing dashes. Used to build URL-safe path segments.
 * Shared with the Bun ingestion script — keep browser-only APIs out.
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Join the defined fields of a Companies House address into a single
 * comma-separated string. Returns an empty string when the address is
 * `null`/`undefined` or all fields are falsy.
 */
export function formatAddress(
  address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  } | null,
) {
  if (!address) return '';
  return [
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.region,
    address.postal_code,
    address.country,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Buffer logs to `window.__dlog` — immune to console.log stripping and hydration re-mounts. */
export function dlog(...args: unknown[]) {
  const w = globalThis as Record<string, unknown>;
  if (!Array.isArray(w.__dlog)) w.__dlog = [];
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  (w.__dlog as string[]).push(line);
}

/**
 * Combine HMRC `townCity` + `county` into a comma-separated display string.
 * Dedupes case-insensitively (so "London, London" collapses to "London") and
 * titleCases each remaining part. Returns an empty string when both are
 * falsy.
 */
export function formatLocation(
  townCity?: string | null,
  county?: string | null,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of [townCity, county]) {
    if (!value) continue;
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    parts.push(titleCase(trimmed));
  }
  return parts.join(', ');
}

// Trailing legal-entity suffixes stripped from a company name before searching.
const SEARCH_SUFFIXES =
  /[\s,]+(?:limited|ltd|plc|llp|llc|lp|cic|cio|inc|incorporated|corp|corporation|unlimited)\.?\s*$/i;

/**
 * Reduce a registered company name to a search-friendly query for external
 * platforms (Google, LinkedIn). Drops parenthetical qualifiers like `(UK)`,
 * any `t/a` ("trading as") tail, and trailing legal-entity suffixes (Ltd,
 * Limited, PLC, LLP, …) — all noise that pushes the platform onto the wrong
 * result. Falls back to the trimmed original if cleaning would empty it.
 */
export function companySearchName(name: string): string {
  const original = name.trim();
  let s = original
    .replace(/\([^)]*\)/g, ' ') // "(UK)", "(Holdings)", …
    .replace(/\b(?:t\/a|trading as)\b.*$/i, ' ') // legal name precedes "t/a …"
    .replace(/\s+/g, ' ')
    .trim();

  // Peel trailing suffixes repeatedly (e.g. "Foo & Co Ltd." -> "Foo & Co").
  let prev: string;
  do {
    prev = s;
    s = s.replace(SEARCH_SUFFIXES, '').trim();
  } while (s !== prev);

  s = s
    .replace(/[\s,]+(?:&|and)\s+co\.?\s*$/i, '') // dangling "& Co"
    .replace(/[\s,&-]+$/, '') // leftover trailing punctuation
    .trim();

  return s || original;
}

/**
 * Format an ISO date string as a UK long-form date (`5 April 2026`). Returns
 * an empty string for missing or unparseable input.
 */
export function formatDate(dateStr?: string | null) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
