// Resolving what the operator meant in the IP field: they either picked a suggestion, typed a
// full address, or typed a fragment to search with.

/** True when `s` reads as a complete address rather than a fragment being used to filter. */
export function isCompleteIp(s: string): boolean {
  const v = s.trim();
  if (v.includes(':')) return v.length >= 3; // IPv6; the profile query validates the rest
  const parts = v.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

/**
 * What Enter should submit. A highlighted suggestion always wins. Otherwise a complete address is
 * taken literally — so a full IP that merely prefixes a busier one is never swapped out — while a
 * fragment resolves to the top match, which is what typing to search implies.
 */
export function resolveIpEntry(
  typed: string,
  cursor: number,
  matches: string[],
): string {
  if (cursor >= 0 && matches[cursor]) return matches[cursor];
  if (isCompleteIp(typed)) return typed.trim();
  return matches[0] ?? typed.trim();
}
