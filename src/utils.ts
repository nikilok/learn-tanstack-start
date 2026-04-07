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
