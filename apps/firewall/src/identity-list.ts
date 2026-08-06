// Which identities the picker offers. The busiest are the easy half; the interesting half is
// quieter, because an actor trying not to be noticed is quiet by construction. Volume rank is
// the one axis it can control, so a longer top-list is a weak instrument against it — this
// picks a band from the other end instead, and marks the free tell that does not depend on
// volume at all.

import { alpnOf } from './ip-signals';

export type Row = [string, number];

/**
 * Floor for the quiet band. Below this an identity cannot clear the ban advisory's own volume
 * requirement, so it could not be adjudicated even if it looked wrong — offering it would offer
 * a decision that cannot be made. It also excludes the real bottom of the list, which is one-off
 * visitors and single-request crawlers; a harvester cannot hide there because harvesting needs
 * volume.
 */
export const QUIET_FLOOR = 100;

/**
 * The quiet band: identities outside the busiest `skip`, still above `floor`, lowest first.
 * Expects `rows` sorted by count descending, which is what `top()` returns.
 */
export function quietBand(
  rows: Row[],
  skip: number,
  count: number,
  floor = QUIET_FLOOR,
): Row[] {
  if (count <= 0) return [];
  return rows
    .slice(skip)
    .filter(([, c]) => c >= floor)
    .slice(-count)
    .reverse();
}

/**
 * True when a JA4 offered no ALPN, which no mainstream browser does. Derived from the digest
 * string itself, so it costs nothing to show for every row.
 *
 * A prompt to profile, never a verdict: a verified crawler inverts this tell (see the
 * bot-verified blocker in ban-advice), so a marked row still has to be adjudicated.
 */
export function noAlpn(digest: string): boolean {
  return alpnOf(digest) === '00';
}

/**
 * Rows the cursor can move over, busiest first then the quiet band. One flat list so selection,
 * Enter and the cursor cannot disagree about what is on screen.
 */
export function pickable(busiest: Row[], quiet: Row[]): Row[] {
  return [...busiest, ...quiet];
}

/**
 * Whether the quiet band fits beside the busiest list, and how many rows the picker will occupy.
 *
 * `rows` is what the pane must give back so its bordered box stays inside the viewport. Under-
 * reserving overflows the frame, which scrolls the terminal and hides the editor cursor, so this
 * has to count the captions as well as the rows.
 */
export function pickerLayout(
  busiest: number,
  quiet: number,
  idWidth: number,
  width: number,
  rowChrome: number,
  gap: number,
): { twoCol: boolean; rows: number } {
  const twoCol = quiet > 0 && width >= 2 * (rowChrome + idWidth) + gap;
  return {
    twoCol,
    rows:
      (twoCol ? Math.max(busiest, quiet) : busiest + quiet) + (quiet ? 1 : 0),
  };
}
