import { describe, expect, test } from 'bun:test';

import {
  createRunner,
  jump,
  PLAYER_R,
  PLAYER_X,
  runnerScore,
  stepRunner,
} from './runner.ts';
import type { RunnerState } from './runner.ts';

const NEVER = () => 0.99; // rnd stub that keeps spawns as far apart as the range allows
const FRAME = 1 / 60;

/** Runs n frames with no input. */
function run(s: RunnerState, frames: number, fastFall = false): RunnerState {
  let next = s;
  for (let i = 0; i < frames; i++)
    next = stepRunner(next, FRAME, fastFall, NEVER);
  return next;
}

/** A started run on an empty stretch, for anything that is not about buildings. */
function clearRun(): RunnerState {
  return { ...jump(createRunner(600)), nextSpawn: 1e9 };
}

/** A run with a single building parked right where the lens is. */
function wall(y = 0): RunnerState {
  return {
    ...createRunner(600),
    started: true,
    y,
    obstacles: [{ x: PLAYER_X - PLAYER_R, w: 30, h: 50, lights: 3 }],
  };
}

describe('idle', () => {
  test('nothing moves until the first jump', () => {
    const s = createRunner(600);
    expect(run(s, 60)).toEqual(s);
  });

  test('the first jump starts the run and launches in one press', () => {
    const s = jump(createRunner(600));
    expect(s.started).toBe(true);
    expect(s.vy).toBeGreaterThan(0);
  });
});

describe('jumping', () => {
  test('the lens leaves the ground and comes back to it', () => {
    const airborne = run(clearRun(), 12);
    expect(airborne.y).toBeGreaterThan(0);
    expect(run(airborne, 120).y).toBe(0);
  });

  test('a second press mid-air is ignored', () => {
    const airborne = run(clearRun(), 12);
    expect(jump(airborne)).toBe(airborne);
  });

  test('holding down brings it back to the ground sooner', () => {
    const airborne = run(clearRun(), 6);
    expect(run(airborne, 14, true).y).toBeLessThan(run(airborne, 14).y);
  });

  test('the ground is a floor, never overshot into', () => {
    const landed = run(clearRun(), 200, true);
    expect(landed.y).toBe(0);
    expect(landed.vy).toBe(0);
  });
});

describe('pace', () => {
  test('speed ramps up but stops at the cap', () => {
    const early = run(clearRun(), 60);
    const later = run(early, 600);
    expect(later.speed).toBeGreaterThan(early.speed);
    expect(run(later, 100_000).speed).toBe(run(later, 200_000).speed);
  });

  test('score follows distance', () => {
    const s = run(clearRun(), 300);
    expect(runnerScore(s)).toBeGreaterThan(0);
    expect(runnerScore(run(s, 60))).toBeGreaterThan(runnerScore(s));
  });

  test('a long stall advances one clamped frame, not a teleport', () => {
    const s = clearRun();
    // Ten seconds of dt would otherwise carry the lens straight through a building.
    expect(stepRunner(s, 10, false, NEVER).dist).toBeLessThan(
      stepRunner(s, 0.05, false, NEVER).dist + 1,
    );
  });
});

describe('buildings', () => {
  test('they scroll in from the right and are dropped past the left edge', () => {
    let s = { ...createRunner(600), started: true, nextSpawn: 0 };
    s = stepRunner(s, FRAME, false, NEVER);
    expect(s.obstacles).toHaveLength(1);
    expect(s.obstacles[0]!.x).toBeGreaterThan(500);
    const scrolled = run(s, 600);
    expect(scrolled.obstacles.every((o) => o.x + o.w > -20)).toBe(true);
  });

  test('spacing scales with the pace, so a faster run is not unfair', () => {
    const slow = stepRunner(
      { ...createRunner(600), started: true, nextSpawn: 0, speed: 300 },
      FRAME,
      false,
      NEVER,
    );
    const fast = stepRunner(
      { ...createRunner(600), started: true, nextSpawn: 0, speed: 700 },
      FRAME,
      false,
      NEVER,
    );
    expect(fast.nextSpawn - fast.dist).toBeGreaterThan(
      slow.nextSpawn - slow.dist,
    );
  });
});

describe('collisions', () => {
  test('running into a building ends the run', () => {
    expect(stepRunner(wall(), FRAME, false, NEVER).over).toBe(true);
  });

  test('clearing it overhead does not', () => {
    expect(stepRunner(wall(80), FRAME, false, NEVER).over).toBe(false);
  });

  test('a building the lens has not reached is not a hit', () => {
    const ahead = {
      ...wall(),
      obstacles: [{ x: 300, w: 30, h: 50, lights: 3 }],
    };
    expect(stepRunner(ahead, FRAME, false, NEVER).over).toBe(false);
  });

  test('a finished run is frozen, whatever the input', () => {
    const dead = stepRunner(wall(), FRAME, false, NEVER);
    expect(stepRunner(dead, FRAME, false, NEVER)).toBe(dead);
    expect(jump(dead)).toBe(dead);
  });
});
