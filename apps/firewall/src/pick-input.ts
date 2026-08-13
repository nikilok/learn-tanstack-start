// What the operator typed or highlighted in the identity picker, and what it resolves to.

import { JA4_DENY } from './deny-list';
import type { Subject } from './ip-profile';

export type PickKind = 'ip' | 'ja4';

// Everything an IPv4/IPv6 literal can contain. A JA4 also carries letters past f and underscores.
const IP_CHARS = /^[0-9a-fA-F.:]+$/;
const IP_TYPED = /[^0-9a-fA-F.:]/g;
const JA4_TYPED = /[^0-9a-z_]/gi;
const MAX_TYPED = 45; // the longest IPv6 literal

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
  const valid = kind === 'ip' ? IP_CHARS.test(v) : JA4_DENY.valid(v);
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
/** Rows matching what has been typed. A blank query matches everything. */
export function filterIdentities(
  rows: [string, number][],
  query: string,
): [string, number][] {
  return query ? rows.filter(([id]) => id.includes(query)) : rows;
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
