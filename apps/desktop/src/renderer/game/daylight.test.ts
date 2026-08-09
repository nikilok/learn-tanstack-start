import { describe, expect, test } from 'bun:test';

import { DAY_LENGTH, isNightAt, skyAt } from './daylight.ts';
import { createRunner, SCORE_PER_PX } from './runner.ts';

describe('isNightAt', () => {
  test('a run opens in the theme the app is already in', () => {
    // The first thing anybody sees has to match the app they were just using; the flips
    // are departures from that, not a cycle of their own.
    expect(isNightAt(true, 0)).toBe(true);
    expect(isNightAt(false, 0)).toBe(false);
    expect(isNightAt(true, DAY_LENGTH - 1)).toBe(true);
    expect(isNightAt(false, DAY_LENGTH - 1)).toBe(false);
  });

  test('it turns over at each milestone, and keeps turning', () => {
    const flips = [0, 1, 2, 3, 4].map((n) =>
      isNightAt(true, DAY_LENGTH * n + 10),
    );
    expect(flips).toEqual([true, false, true, false, true]);
    // And from the other starting theme it is the exact mirror, never converging on one.
    expect(
      [0, 1, 2, 3, 4].map((n) => isNightAt(false, DAY_LENGTH * n + 10)),
    ).toEqual(flips.map((f) => !f));
  });

  test('a score below zero is still a sky, not a crash', () => {
    expect(isNightAt(true, -50)).toBe(true);
  });
});

describe('skyAt', () => {
  test('it reads the run rather than a clock', () => {
    // Score, not elapsed time: an idle screen must not sit there strobing between skies.
    const at = (score: number) => ({
      ...createRunner(1280),
      dist: score / SCORE_PER_PX,
    });
    expect(skyAt(at(0), true)).toBe(true);
    expect(skyAt(at(DAY_LENGTH + 20), true)).toBe(false);
    expect(skyAt(at(DAY_LENGTH * 2 + 20), true)).toBe(true);
  });
});
