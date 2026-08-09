/**
 * Day turning to night and back as a run goes on.
 *
 * The screen already has two complete looks — the footer's ink-wash daytime sky and its
 * star field — and a run only ever showed you one of them. Turning the sky over at
 * milestones costs nothing, gives a long run something to arrive at, and means the sumi
 * sweep and the constellation are both worth having.
 *
 * Driven by score for the same reason everything else is: it should land at a moment the
 * player can point at, not on a wall clock that keeps running while they are not playing.
 * Pure, so the flip points can be checked without rendering anything.
 *
 * The change is a straight cut, deliberately. An earlier version dipped the frame through
 * black so the two skies crossed; it read as the game glitching rather than as the sun
 * going down, and it put a blackout in the middle of a run someone was playing.
 */
import { SCORE_PER_PX } from './runner.ts';
import type { RunnerState } from './runner.ts';

/**
 * Score per half-cycle. Long enough that a short run keeps the theme it started in — the
 * first one anybody plays should look like the app they were using — and short enough that
 * a run which gets going sees the sky turn over more than once.
 */
export const DAY_LENGTH = 250;

/**
 * Whether the run is in its dark half. `appDark` is the theme the screen opened in, so the
 * first stretch of every run matches the app and the flips are departures from it rather
 * than an unrelated cycle of their own.
 */
export function isNightAt(appDark: boolean, score: number): boolean {
  const flips = Math.floor(Math.max(0, score) / DAY_LENGTH);
  return flips % 2 === 0 ? appDark : !appDark;
}

/** The sky this frame should be drawn in. */
export function skyAt(s: RunnerState, appDark: boolean): boolean {
  return isNightAt(appDark, s.dist * SCORE_PER_PX);
}
