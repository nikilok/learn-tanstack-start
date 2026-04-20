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
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b\w+\b/g, (word) =>
      UPPERCASE_WORDS.has(word.toLowerCase()) ? word.toUpperCase() : word,
    );
}

/**
 * Lowercase and replace runs of non-alphanumeric characters with `-`,
 * trimming leading/trailing dashes. Used to build URL-safe path segments.
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
