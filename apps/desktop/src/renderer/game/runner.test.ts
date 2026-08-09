import { describe, expect, test } from 'bun:test';

import { LANDMARKS, LANDMARK_ORDER } from '@ss/skyline';

import {
  FULL_TILT,
  createRunner,
  JUMP_APEX,
  jump,
  PLAYER_R,
  PLAYER_X,
  runnerScore,
  CHALLENGE_FROM,
  CHALLENGE_FULL,
  SCORE_PER_PX,
  SPEED_TOPS_AT,
  speedAt,
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

/** Distance that puts a run at the given score, for driving the difficulty curve. */
function scoreToDist(score: number): number {
  return score / SCORE_PER_PX;
}
/** Every obstacle the run can spawn at that score, by sweeping the shape picker's rnd. */
function spawnsAt(score: number): RunnerState['obstacles'] {
  const dist = scoreToDist(score);
  const out: RunnerState['obstacles'] = [];
  for (let i = 0; i < 24; i++) {
    const pick = i / 24;
    const s = stepRunner(
      { ...createRunner(600), started: true, dist, nextSpawn: dist },
      FRAME,
      false,
      () => pick,
    );
    out.push(...s.obstacles);
  }
  return out;
}

/** A run with a single landmark parked right where the lens is. */
function wall(y = 0): RunnerState {
  return {
    ...createRunner(600),
    started: true,
    y,
    obstacles: [{ x: PLAYER_X - PLAYER_R, w: 60, h: 120, kind: 'gherkin' }],
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

  test('the ground starts slow and only reaches cruise deep into a run', () => {
    // The complaint this pins: a run that is at full speed from the first jump.
    const start = speedAt(0);
    const cruise = speedAt(scoreToDist(SPEED_TOPS_AT));
    expect(speedAt(scoreToDist(100))).toBeLessThan(
      start + (cruise - start) * 0.3,
    );
    expect(cruise).toBeGreaterThan(start);
  });

  test('it never dips back, at any point', () => {
    // A dip reads as a stumble, and the curve now has two joins where one could hide.
    let previous = 0;
    for (let score = 0; score <= 2500; score += 25) {
      const now = speedAt(scoreToDist(score));
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  test('even at full pace there is over a second to react', () => {
    // This screen is what someone watches while they wait, so the run has to stay
    // watchable rather than turn into a reflex test. Measured the way the player
    // experiences it: from an obstacle entering on the right to reaching the lens.
    const width = 1280;
    const s = stepRunner(
      { ...createRunner(width), started: true, nextSpawn: 0 },
      FRAME,
      false,
      NEVER,
    );
    const entering = s.obstacles[0]!.x;
    const travel = entering - PLAYER_X;
    expect(travel / speedAt(scoreToDist(SPEED_TOPS_AT))).toBeGreaterThan(1);
    // And a whole lot longer than that on the first one you ever see.
    expect(travel / speedAt(0)).toBeGreaterThan(2);
  });

  test('it holds one pace before it starts pressing again', () => {
    // The stretch that makes the second climb register: without it the run only ever gets
    // faster, and there is never a pace you learn well enough to notice it change.
    const cruise = speedAt(scoreToDist(SPEED_TOPS_AT));
    for (const score of [SPEED_TOPS_AT, 700, CHALLENGE_FROM]) {
      expect(speedAt(scoreToDist(score))).toBeCloseTo(cruise, 6);
    }
    expect(speedAt(scoreToDist(CHALLENGE_FROM + 200))).toBeGreaterThan(cruise);
    expect(CHALLENGE_FROM).toBeGreaterThan(SPEED_TOPS_AT);
    // And the difficulty curve keeps moving through that stretch, or the middle of the
    // run would be flat in every dimension at once.
    expect(FULL_TILT).toBeGreaterThan(SPEED_TOPS_AT);
  });

  test('the second climb tops out and then holds for good', () => {
    // The complaint this pins from the other side: a run that keeps accelerating until it
    // is unplayable. It presses harder past the milestone, but only up to a ceiling.
    const ceiling = speedAt(scoreToDist(CHALLENGE_FULL));
    for (const score of [CHALLENGE_FULL, 5_000, 50_000, 1e6]) {
      expect(speedAt(scoreToDist(score))).toBeCloseTo(ceiling, 6);
    }
    // Even flat out, an obstacle is on screen long enough to answer.
    expect((1280 + 40 - PLAYER_X) / ceiling).toBeGreaterThan(0.85);
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

describe('landmarks', () => {
  test('they scroll in from the right and are dropped past the left edge', () => {
    let s = { ...createRunner(600), started: true, nextSpawn: 0 };
    s = stepRunner(s, FRAME, false, NEVER);
    expect(s.obstacles).toHaveLength(1);
    expect(s.obstacles[0]!.x).toBeGreaterThan(500);
    const scrolled = run(s, 900);
    expect(scrolled.obstacles.every((o) => o.x + o.w > -50)).toBe(true);
  });

  test('nothing that spawns is too tall to jump, at any point in a run', () => {
    // The rule a new obstacle can silently break: add one taller than the jump reaches and
    // the run becomes unwinnable at that spawn, with nothing failing anywhere else.
    const heights = new Set<number>();
    for (const score of [0, 150, 300, 500, 900, 1200]) {
      for (const o of spawnsAt(score)) heights.add(o.h);
    }
    expect(heights.size).toBeGreaterThan(1);
    for (const h of heights) {
      // Cleared with real room to spare, not by a pixel.
      expect(h).toBeLessThan(JUMP_APEX * 0.7);
    }
  });

  test('every landmark keeps its own proportions', () => {
    // A landmark stretched to fit a box stops being that landmark — Big Ben widened to a
    // building's footprint reads as a slab with a clock on it. The engine derives `w` from
    // the shared bounding box, so this pins that it never drifts from the artwork.
    for (const o of spawnsAt(1200)) {
      if (o.kind === 'bus') continue;
      const l = LANDMARKS[o.kind];
      expect(o.w).toBe(Math.round((l.w * o.h) / l.h));
    }
  });

  test('the opening is one easy obstacle, not the whole set', () => {
    // The complaint this pins: everything showing up at once on the first jump.
    const opening = spawnsAt(0);
    expect(opening.length).toBeGreaterThan(0);
    expect(new Set(opening.map((o) => o.kind)).size).toBe(1);
    // Comfortably under the jump, so the first one is never a near thing.
    expect(Math.max(...opening.map((o) => o.h))).toBeLessThan(JUMP_APEX * 0.4);
  });

  test('harder shapes unlock as the score climbs', () => {
    const variety = [0, 150, 300, 500, 900, 1200].map(
      (score) => new Set(spawnsAt(score).map((o) => o.kind)).size,
    );
    // Never fewer choices than before, and more by the end than at the start.
    expect(variety).toEqual([...variety].sort((a, b) => a - b));
    expect(variety.at(-1)).toBeGreaterThan(variety[0] as number);
    // Every landmark in the footer eventually turns up in the run.
    const late = new Set(spawnsAt(1200).map((o) => o.kind));
    for (const id of LANDMARK_ORDER) expect(late.has(id)).toBe(true);
  });

  test('the bus waits for its milestone, and is the long low one', () => {
    const isBus = (o: { kind: string }) => o.kind === 'bus';
    expect(spawnsAt(0).some(isBus)).toBe(false);
    expect(spawnsAt(300).some(isBus)).toBe(false);
    const late = spawnsAt(900);
    const buses = late.filter(isBus);
    expect(buses.length).toBeGreaterThan(0);
    // Wider than it is tall, and wider-to-taller than any landmark it shares the road with.
    const ratio = (o: { w: number; h: number }) => o.w / o.h;
    expect(Math.min(...buses.map(ratio))).toBeGreaterThan(1.4);
    expect(Math.min(...buses.map(ratio))).toBeGreaterThan(
      Math.max(...late.filter((o) => !isBus(o)).map(ratio)),
    );
  });

  test('the gap between obstacles tightens as the run goes on', () => {
    // Measured in seconds of travel, which is the reaction time the player actually has.
    const gapSeconds = (score: number) => {
      const dist = scoreToDist(score);
      const before = {
        ...createRunner(600),
        started: true,
        dist,
        nextSpawn: dist,
      };
      const after = stepRunner(before, FRAME, false, () => 0.5);
      return (after.nextSpawn - after.dist) / speedAt(dist);
    };
    const early = gapSeconds(0);
    const late = gapSeconds(FULL_TILT);
    expect(early).toBeGreaterThan(late * 1.5);
    // Still longer than a jump hangs in the air, or it stops being clearable at all.
    expect(late).toBeGreaterThan(0.7);
  });

  test('a faster run still spaces obstacles further apart on screen', () => {
    // Reaction time shrinks with progress (the test above), but the pixel spacing must not
    // — bunching them up on screen at speed would make a late run unreadable as well as
    // fast. Driven by distance, since the pace is derived from it.
    const pixelGap = (score: number) => {
      const dist = scoreToDist(score);
      const after = stepRunner(
        { ...createRunner(600), started: true, dist, nextSpawn: dist },
        FRAME,
        false,
        () => 0.5,
      );
      return after.nextSpawn - after.dist;
    };
    expect(pixelGap(FULL_TILT)).toBeGreaterThan(pixelGap(0));
  });
});

describe('collisions', () => {
  test('running into a landmark ends the run', () => {
    expect(stepRunner(wall(), FRAME, false, NEVER).over).toBe(true);
  });

  test('clearing it overhead does not', () => {
    expect(stepRunner(wall(200), FRAME, false, NEVER).over).toBe(false);
  });

  test('a landmark the lens has not reached is not a hit', () => {
    const ahead = {
      ...wall(),
      obstacles: [{ x: 600, w: 60, h: 120, kind: 'gherkin' as const }],
    };
    expect(stepRunner(ahead, FRAME, false, NEVER).over).toBe(false);
  });

  test('a finished run is frozen, whatever the input', () => {
    const dead = stepRunner(wall(), FRAME, false, NEVER);
    expect(stepRunner(dead, FRAME, false, NEVER)).toBe(dead);
    expect(jump(dead)).toBe(dead);
  });
});
