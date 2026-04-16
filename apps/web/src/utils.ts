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

export function titleCase(str: string | null) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b\w+\b/g, (word) =>
      UPPERCASE_WORDS.has(word.toLowerCase()) ? word.toUpperCase() : word,
    );
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

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
