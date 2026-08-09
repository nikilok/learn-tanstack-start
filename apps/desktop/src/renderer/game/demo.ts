/**
 * The lens playing itself, so a screen nobody has touched is not a still picture of a
 * character standing next to a building. It takes over after a stretch of quiet and hands
 * back the moment anyone presses anything.
 *
 * Pure, like the rest of the engine: state in, a decision out. Which means the player it
 * plays against is exactly the one a person plays against, and the timing rule below can be
 * checked without running the game.
 */
import {
  JUMP_APEX,
  PLAYER_R,
  PLAYER_X,
  SCORE_PER_PX,
  speedAt,
} from './runner.ts';
import type { RunnerState } from './runner.ts';

/** Quiet before the lens starts playing on its own. */
export const DEMO_AFTER_MS = 12_000;

/**
 * How far the demo takes a run before bowing out and starting again. A range rather than a
 * number: every stint ending at the same score is a loop you can set your watch by, and the
 * whole point of it is to look like someone playing.
 *
 * Not a technical limit — it plays indefinitely if left to. It is that a machine reeling off
 * scores nobody is going to match is discouraging to walk up to, and the number in the
 * corner is meant to be worth beating. The low end shows the Gherkin and the Eye; the high
 * end reaches Big Ben and the first of the pressing pace, without ever looking untouchable.
 */
export const DEMO_MIN_SCORE = 300;
export const DEMO_MAX_SCORE = 1000;

/** The score this particular stint will bow out at. */
export function demoStintTarget(rnd: () => number): number {
  const span = DEMO_MAX_SCORE - DEMO_MIN_SCORE;
  return Math.round(DEMO_MIN_SCORE + Math.min(0.999999, rnd()) * span);
}

/** Each half of the demo's changeover: out to nothing, then back in on a fresh run. */
export const DEMO_FADE_MS = 500;

/** True once this stint has gone as far as it was going to and should bow out. */
export function demoStintOver(s: RunnerState, target: number): boolean {
  return s.dist * SCORE_PER_PX >= target;
}

/**
 * How far ahead of contact to jump, in seconds. A jump is ~0.65s in the air and clears an
 * obstacle's height for the middle ~0.38s of it, so leaving at about half the rise puts the
 * apex over the obstacle with room either side for a wide one.
 */
const LEAD_SECONDS = 0.3;

/**
 * Whether the demo player would jump right now.
 *
 * Deliberately the same information a person has — what is on the ground ahead and how fast
 * it is coming — rather than the spawn schedule. It plays the game rather than the engine.
 */
export function demoShouldJump(s: RunnerState): boolean {
  if (!s.started || s.over || s.y > 0) return false; // mid-air presses do nothing anyway
  const speed = speedAt(s.dist);
  if (speed <= 0) return false;
  const nose = PLAYER_X + PLAYER_R;
  for (const o of s.obstacles) {
    const gap = o.x - nose;
    if (gap < 0) continue; // already level with it or past it; nothing left to time
    // Anything it cannot clear is not worth jumping at, and nothing spawned should be —
    // if that ever changes this stops flailing at it rather than jumping into it.
    if (o.h >= JUMP_APEX) continue;
    if (gap / speed <= LEAD_SECONDS) return true;
  }
  return false;
}
