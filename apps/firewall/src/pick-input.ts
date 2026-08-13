// What the operator typed or highlighted in the identity picker, and what it resolves to.

import { JA4_DENY } from './deny-list';
import type { Subject } from './ip-profile';

export type PickKind = 'ip' | 'ja4';

const IP_TYPED = /[^0-9a-fA-F.:]/g;
const JA4_TYPED = /[^0-9a-z_]/gi;
const MAX_TYPED = 45; // the longest IPv6 literal

/** One IPv4 octet: 0-255, and no leading zeros, which some resolvers read as octal. */
const OCTET = /^(0|[1-9]\d{0,2})$/;

/** A complete IPv4 literal. Four octets in range — not merely four things made of digits. */
function isIpv4(v: string): boolean {
  const parts = v.split('.');
  return (
    parts.length === 4 && parts.every((p) => OCTET.test(p) && Number(p) <= 255)
  );
}

/**
 * A plausible IPv6 literal: hex groups, at most one `::`, optionally ending in an IPv4 tail.
 *
 * Deliberately looser than the IPv4 check. The cost of the two errors is not symmetric — a
 * rejected address is one an operator can SEE in the traffic and cannot look up, while an
 * over-permissive one only costs an empty tab.
 */
function isIpv6(v: string): boolean {
  if (!v.includes(':')) return false;
  if (v === '::') return true; // all-zeros: legal, and it has no groups to check
  if (v.includes(':::')) return false; // three colons is not an elision, and filtering empties hid it
  const elisions = v.split('::').length - 1;
  if (elisions > 1) return false; // only one elision is legal
  // A lone leading or trailing colon is not an elision, and `1:2:3` is not an address either —
  // counting groups rather than checking their shape accepted both.
  if (v.startsWith(':') && !v.startsWith('::')) return false;
  if (v.endsWith(':') && !v.endsWith('::')) return false;
  const parts = v.split(':').filter(Boolean);
  if (!parts.length) return false;
  let units = 0;
  for (const [i, g] of parts.entries()) {
    if (/^[0-9a-f]{1,4}$/i.test(g)) units += 1;
    // An IPv4 tail stands for the last two groups.
    else if (i === parts.length - 1 && isIpv4(g)) units += 2;
    else return false;
  }
  return elisions === 1 ? units < 8 : units === 8;
}

/** The identity as it is stored and queried. JA4 digests are case-insensitive handles; IPs are kept as written. */
export function normalizeIdentity(kind: PickKind, value: string): string {
  const v = value.trim();
  return kind === 'ja4' ? v.toLowerCase() : v;
}

/** The subject `value` names, or the message saying why it is not one. */
export function resolveSubject(
  kind: PickKind,
  value: string,
): { subject: Subject } | { error: string } {
  const v = normalizeIdentity(kind, value);
  // The whole literal, not just its permitted characters. A character check passed
  // `999.999.999.999` and `1.2.3.4.5`, which open a tab and query an address that cannot exist.
  const valid = kind === 'ip' ? isIpv4(v) || isIpv6(v) : JA4_DENY.valid(v);
  if (!v || !valid)
    return { error: kind === 'ip' ? 'not an IP address' : 'not a JA4 digest' };
  return { subject: { kind, value: v } };
}

/**
 * The field after a keystroke or a paste.
 *
 * Filtered WITHIN the chunk rather than tested whole: a paste arrives as one event, so requiring
 * the chunk to match meant pasting an IP silently did nothing.
 */
export function typeIdentity(
  kind: PickKind,
  current: string,
  chunk: string,
): string {
  const allowed = kind === 'ip' ? IP_TYPED : JA4_TYPED;
  return (current + chunk.replace(allowed, '')).slice(0, MAX_TYPED);
}

// Substring, not prefix: an IP is often recognised by its tail as much as its network part.
// Case-insensitive because the field accepts either: dashboards render digests upper-case, and
// a digest pasted from one filtered the list to nothing against the lower-case rows.
/** Rows matching what has been typed. A blank query matches everything. */
export function filterIdentities(
  rows: [string, number][],
  query: string,
): [string, number][] {
  if (!query) return rows;
  const q = query.toLowerCase();
  return rows.filter(([id]) => id.toLowerCase().includes(q));
}

/**
 * How many busiest rows the pane has room for.
 *
 * Bounded by the viewport as well as by `max`: these rows are taken from the pane below and the
 * pane's height can be as little as 8.
 */
export function busiestCap(
  paneHeight: number,
  quietRows: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, paneHeight - quietRows));
}

/**
 * The subjects `o` opens, bounded.
 *
 * Busiest column only, and capped: each subject costs a profile's worth of queries, so folding in
 * the quiet band would nearly triple what one keypress spends.
 */
export function subjectsToOpen(
  rows: [string, number][],
  kind: PickKind,
  max: number,
): Subject[] {
  return rows
    .slice(0, max)
    .map(([value]) => ({ kind, value: normalizeIdentity(kind, value) }));
}
