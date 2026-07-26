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

/** Strips the SEO site-name suffix so the desktop preview's title bar shows just the page name. Mirror of the shell's cleanTitle (apps/desktop/src/main/site.ts) — keep the regexes identical (both copies are covered by matching tests). */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[|—–-]\s*SponsorSearch(\.co\.uk)?\s*$/i, '')
    .replace(/\s*-\s*UK Visa Sponsor\s*$/i, '')
    .replace(/\s*[.—–-]\s*Skilled Worker Visa Sponsors\s*$/i, '')
    .trim();
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

/** Order visa routes for display: Skilled Worker first, then alphabetical — the single route-priority policy shared by listing chips and detail pages. */
export function skilledWorkerFirst(routes: string[]): string[] {
  return [...routes].sort((a, b) =>
    a === 'Skilled Worker'
      ? -1
      : b === 'Skilled Worker'
        ? 1
        : a.localeCompare(b),
  );
}

/** Humanize a hyphenated CH enum value ("voluntary-arrangement" → "Voluntary Arrangement"). */
export function humanizeEnum(value: string | null): string {
  return titleCase((value ?? '').replace(/-/g, ' '));
}

/** Canonical key for company-name equality (case, punctuation, LTD/LIMITED). */
export function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,]/g, '')
    .replace(/\bLIMITED\b/g, 'LTD')
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * "Previously <name>" line for a previous-company-name match. Returns an
 * empty string when there is no match. Single source for BOTH the rendered
 * line in `HmrcCard` and the height estimator's `getText` in `HmrcResults` —
 * the two must measure/render identical text, so never inline this template.
 */
export function previousNameText(name: string | null): string {
  return name ? `Previously ${titleCase(name)}` : '';
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
  // Date-only strings parse as UTC midnight — format in UTC too, or the
  // label renders a day early in any timezone west of Greenwich.
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Format the gap between `date` and now as a human-readable relative string
 * ("a few seconds ago", "5 mins ago", "3 hours ago", "2 days ago", "4 months
 * ago", "2 years ago"). Empty string for an invalid date. Powers the footer's
 * ingestion freshness pill and each download's release age.
 */
export function formatRelative(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 45) return 'a few seconds ago';
  if (diffSec < 90) return '1 min ago';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 45) return `${diffMin} mins ago`;
  if (diffMin < 90) return '1 hour ago';
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 22) return `${diffHr} hours ago`;
  if (diffHr < 36) return '1 day ago';
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 26) return `${diffDay} days ago`;
  const diffMonth = Math.round(diffDay / 30.44);
  if (diffMonth < 12)
    return diffMonth <= 1 ? '1 month ago' : `${diffMonth} months ago`;
  const diffYear = Math.round(diffDay / 365.25);
  return diffYear <= 1 ? '1 year ago' : `${diffYear} years ago`;
}

/**
 * Whether the user has requested reduced motion via the OS. Returns `false` on
 * the server (no `window`).
 */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Whether the browser exposes the WebGPU API. Does not guarantee a working adapter or that
 * a shader compiles — just that `navigator.gpu` is present. `false` on the server.
 */
export function hasWebGpu() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Stamps the page-flip direction on `<html>` for the Safari-scoped view-transition
 * rules in transitions.css (which can't rely on `:active-view-transition-type()` —
 * see the Safari block there). Call synchronously from the handler that navigates
 * with `viewTransition: { types }`, before the OLD snapshot is captured.
 */
export function stampPageFlip(direction: 'forward' | 'back') {
  document.documentElement.setAttribute('data-page-flip', direction);
}

/** Whether the pathname is a company-details page. */
export function isDetailsPath(pathname: string) {
  return pathname.startsWith('/company/');
}
