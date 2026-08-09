import { describe, expect, test } from 'bun:test';

import {
  DEMO_AFTER_MS,
  DEMO_FADE_MS,
  DEMO_MAX_SCORE,
  DEMO_MIN_SCORE,
  demoShouldJump,
  demoStintOver,
  demoStintTarget,
} from './demo.ts';
import {
  createRunner,
  JUMP_APEX,
  jump,
  PLAYER_R,
  PLAYER_X,
  SCORE_PER_PX,
  speedAt,
  stepRunner,
} from './runner.ts';
import type { Obstacle, RunnerState } from './runner.ts';

const FRAME = 1 / 60;
const NEVER = () => 0.99;

/** A started run with one obstacle a given number of seconds away. */
function approaching(secondsAway: number, over: Partial<Obstacle> = {}) {
  const s: RunnerState = { ...jump(createRunner(1280)), nextSpawn: 1e9 };
  const gap = speedAt(s.dist) * secondsAway;
  return {
    ...s,
    y: 0,
    vy: 0,
    obstacles: [
      { x: PLAYER_X + PLAYER_R + gap, w: 30, h: 110, kind: 'gherkin', ...over },
    ] as Obstacle[],
  };
}

describe('demoShouldJump', () => {
  test('it waits until the obstacle is close, then commits', () => {
    expect(demoShouldJump(approaching(1.2))).toBe(false);
    expect(demoShouldJump(approaching(0.6))).toBe(false);
    expect(demoShouldJump(approaching(0.2))).toBe(true);
  });

  test('it does not press mid-air, where a press does nothing', () => {
    const airborne = { ...approaching(0.2), y: 40 };
    expect(demoShouldJump(airborne)).toBe(false);
  });

  test('an idle or finished run is left alone', () => {
    expect(demoShouldJump(createRunner(1280))).toBe(false);
    expect(demoShouldJump({ ...approaching(0.2), over: true })).toBe(false);
  });

  test('an obstacle already level with it is not jumped at', () => {
    // Nothing to time any more; jumping here only lands on the next one badly.
    const past = {
      ...approaching(0.2),
      obstacles: [
        { x: PLAYER_X - 40, w: 30, h: 110, kind: 'gherkin' },
      ] as Obstacle[],
    };
    expect(demoShouldJump(past)).toBe(false);
  });

  test('it ignores anything it could not clear anyway', () => {
    // Nothing spawned is this tall. If that ever changes, the demo stops flinging itself
    // at it every frame and simply runs into it, which is at least honest.
    expect(demoShouldJump(approaching(0.2, { h: JUMP_APEX + 1 }))).toBe(false);
  });

  test('it clears everything its stint throws at it', () => {
    // The real check: play the rule against the actual engine and it should reach the end
    // of its stint without crashing, having been shown the bus and everything before it.
    let s: RunnerState = createRunner(1280);
    let frames = 0;
    // 32-bit throughout: a plain multiply here reaches ~2.3e18, past the point doubles
    // hold every integer, so the low bits round away and feed more zeros back in each
    // round until the stream collapses. This test would still pass against a near-constant
    // source while covering none of the shape and gap variety it is here for.
    const rnd = (() => {
      let seed = 12345;
      return () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 4294967296;
      };
    })();
    const score = () => Math.floor(s.dist * SCORE_PER_PX);
    while (frames < 60 * 300 && !s.over && score() < DEMO_MAX_SCORE) {
      if (!s.started || demoShouldJump(s)) s = jump(s);
      s = stepRunner(s, FRAME, false, rnd);
      frames++;
    }
    expect(s.over).toBe(false);
    expect(score()).toBeGreaterThanOrEqual(DEMO_MAX_SCORE);
  });

  test('it keeps playing properly right up to the changeover', () => {
    // The stint ends with a fade, not by walking into something, so there is no reason to
    // start missing jumps on the way out — that would just look like it got worse.
    const spent = {
      ...approaching(0.1),
      dist: (DEMO_MAX_SCORE - 5) / SCORE_PER_PX,
    };
    expect(demoShouldJump(spent)).toBe(true);
  });
});

describe('demoStintOver', () => {
  test("it is the score against this stint's own target, nothing else", () => {
    const at = (score: number) => ({
      ...createRunner(1280),
      dist: score / SCORE_PER_PX,
    });
    // Either side of the target rather than exactly on it: score and distance are a float
    // round-trip, so the boundary itself lands a rounding error out.
    expect(demoStintOver(at(0), 500)).toBe(false);
    expect(demoStintOver(at(499), 500)).toBe(false);
    expect(demoStintOver(at(501), 500)).toBe(true);
    expect(demoStintOver(at(1500), 500)).toBe(true);
  });

  test('the changeover is quick enough not to read as a stall', () => {
    expect(DEMO_FADE_MS).toBeLessThanOrEqual(800);
  });
});

describe('demoStintTarget', () => {
  test('every stint lands inside the range', () => {
    for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      const target = demoStintTarget(() => r);
      expect(target).toBeGreaterThanOrEqual(DEMO_MIN_SCORE);
      expect(target).toBeLessThanOrEqual(DEMO_MAX_SCORE);
    }
  });

  test('it actually varies, or it is just a fixed cap with extra steps', () => {
    // The point of the range: stints that all end on the same score read as a loop.
    const seen = new Set(
      [0.05, 0.3, 0.55, 0.8, 0.95].map((r) => demoStintTarget(() => r)),
    );
    expect(seen.size).toBe(5);
  });

  test('the range stays short enough not to be discouraging', () => {
    expect(DEMO_MIN_SCORE).toBeGreaterThanOrEqual(200);
    expect(DEMO_MAX_SCORE).toBeLessThanOrEqual(1200);
    expect(DEMO_MAX_SCORE).toBeGreaterThan(DEMO_MIN_SCORE);
  });
});

describe('DEMO_AFTER_MS', () => {
  test('it is long enough to be a lull, not an interruption', () => {
    expect(DEMO_AFTER_MS).toBeGreaterThanOrEqual(8000);
  });

  test('a fresh run steps without the demo touching it', () => {
    const s = stepRunner(createRunner(600), FRAME, false, NEVER);
    expect(s.started).toBe(false);
  });
});
