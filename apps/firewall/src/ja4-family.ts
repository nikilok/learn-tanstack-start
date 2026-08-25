// Grouping JA4 digests by the part of the fingerprint a client rebuild does not change.
//
// NO CALLERS, deliberately. Driving this from the unattended loop was tried and reverted: the
// state and surfaces around it cost far more than it returned. Kept for an on-demand operator
// query, where a person reads the answer and nothing is recorded on the strength of it.

import { JA4_DENY } from './deny-list';
import { mixOf, renderingRequests } from './ip-signals';
import { type Row, countOf } from './observability';

/** Trimmed and case-folded. `normalize` alone only lowercases, and the list files do not trim their fields. */
function normalizeDigest(digest: string): string {
  return JA4_DENY.normalize(digest.trim());
}

/** The profile and cipher halves of a JA4, without the extensions hash. Empty for anything malformed, so a bad value never groups with a good one. */
export function familyOf(digest: string): string {
  // The package's own shape test, not a looser one. Counting three non-empty parts accepts
  // `a_b_c` and drops a fourth segment silently, so any junk sharing a prefix joins a real family.
  const v = normalizeDigest(digest);
  return JA4_DENY.valid(v) ? v.slice(0, v.lastIndexOf('_')) : '';
}

/** Per-digest rendering share over a digest×route summary. Mirrors `nonRendering`'s threshold from the other side, so wire them to one definition if this is ever driven from the screen. */
export function renderSharesByDigest(
  routeRows: Row[],
): Map<string, { total: number; share: number }> {
  // Keyed on the normalised digest. The API echoes digests in either case, and two casings of one
  // fingerprint would otherwise be totalled separately — splitting its traffic, splitting its
  // rendering share, and turning one browser session into two apparent harvesters.
  const byDigest = new Map<string, [string, number][]>();
  for (const r of routeRows) {
    // Validated, not merely non-placeholder. Anything that is not a real digest cannot belong to
    // a family, so counting it here inflates `shares` — and a response of nothing BUT malformed
    // rows then yields a defined-but-empty Set, which reads as "nothing renders anywhere".
    const d = normalizeDigest(String(r.clientJa4Digest ?? ''));
    if (!JA4_DENY.valid(d)) continue;
    const paths = byDigest.get(d) ?? [];
    paths.push([String(r.route ?? ''), countOf(r)]);
    byDigest.set(d, paths);
  }
  const out = new Map<string, { total: number; share: number }>();
  for (const [digest, paths] of byDigest) {
    const total = paths.reduce((n, [, c]) => n + c, 0);
    if (total <= 0) continue;
    out.set(digest, { total, share: renderingRequests(mixOf(paths)) / total });
  }
  return out;
}

/**
 * Families with a member that renders like a browser.
 *
 * A family is a client BUILD LINE, not an actor, and a popular one carries real users
 * permanently — so the relation only carries information where nothing in it renders.
 *
 * Undefined when the rows carry no measurable digest at all. An empty Set is the affirmative
 * claim "nothing renders anywhere", which is the widest possible answer, and a response that
 * arrived empty cannot support it.
 */
export function renderingFamilies(
  routeRows: Row[],
  maxShare: number,
): Set<string> | undefined {
  const shares = renderSharesByDigest(routeRows);
  if (!shares.size) return undefined;
  const families = new Set<string>();
  for (const [digest, { share }] of shares) {
    if (share <= maxShare) continue;
    const family = familyOf(digest);
    if (family) families.add(family);
  }
  return families;
}

/**
 * Digests sharing a family with a listed one, where nothing in that family renders.
 *
 * `rendering` undefined means the family evidence could not be established. That returns nothing:
 * "no browser is on this build line" is an affirmative claim, and a response that may have shed
 * the rendering rows cannot support it. Same direction as every other unread input here — the
 * answer that widens nothing.
 */
export function kinOfListed(
  observed: readonly string[],
  listed: readonly string[],
  rendering: ReadonlySet<string> | undefined,
  /** Digests to leave out of the result WITHOUT their families counting as listed — already-seen or already-handled entries, not identities we acted on. */
  known: readonly string[] = [],
): Set<string> {
  if (!rendering) return new Set();
  const watched = new Set(
    listed.map(familyOf).filter((f) => f && !rendering.has(f)),
  );
  const already = new Set([...listed, ...known].map(normalizeDigest));
  const kin = new Set<string>();
  for (const raw of observed) {
    const digest = normalizeDigest(raw);
    if (!digest || already.has(digest)) continue;
    if (watched.has(familyOf(digest))) kin.add(digest);
  }
  return kin;
}
