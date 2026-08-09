import { describe, expect, test } from 'bun:test';

import {
  DEMO_AFTER_MS,
  DEMO_FADE_MS,
  DEMO_MAX_SCORE,
  demoShouldJump,
  demoStintOver,
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
    const rnd = (() => {
      let seed = 12345;
      return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
    })();
    const score = () => Math.floor(s.dist * SCORE_PER_PX);
    while (frames < 60 * 180 && !s.over && score() < DEMO_MAX_SCORE) {
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

  test('the stint stays short enough not to be discouraging', () => {
    // The point of the cap: a number in the corner nobody is going to match puts people
    // off, and this one is meant to be worth beating.
    expect(DEMO_MAX_SCORE).toBeLessThanOrEqual(400);
  });
});

describe('demoStintOver', () => {
  test('it is the score that ends the stint, nothing else', () => {
    const at = (score: number) => ({
      ...createRunner(1280),
      dist: score / SCORE_PER_PX,
    });
    expect(demoStintOver(at(0))).toBe(false);
    expect(demoStintOver(at(DEMO_MAX_SCORE - 1))).toBe(false);
    expect(demoStintOver(at(DEMO_MAX_SCORE))).toBe(true);
    expect(demoStintOver(at(DEMO_MAX_SCORE * 3))).toBe(true);
  });

  test('the changeover is quick enough not to read as a stall', () => {
    expect(DEMO_FADE_MS).toBeLessThanOrEqual(800);
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
