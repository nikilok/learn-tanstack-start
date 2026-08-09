import { describe, expect, test } from 'bun:test';

import { CLOUD_PUFFY, CLOUD_WIDE, makeClouds, makeStars } from './sky.ts';

/**
 * Deterministic stand-in for Math.random.
 *
 * A short cycling list aliases with the generators under test: a star takes exactly five
 * values, so a ten-value loop gave every star one of two identities and the variety
 * assertions below passed against a source that had stopped varying. 32-bit throughout,
 * because a plain multiply here runs past the point doubles hold every integer and the
 * stream decays toward a constant.
 */
function seeded(): () => number {
  let seed = 987654321;
  return () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
}

describe('makeStars', () => {
  test('every star lands inside the sky', () => {
    for (const s of makeStars(40, seeded())) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThan(1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(1);
      expect(s.r).toBeGreaterThan(0);
    }
  });

  test('lanes spread them across the whole width instead of clumping', () => {
    // The failure this pins is a purely random field: patches and bald spots.
    const xs = makeStars(40, seeded()).map((s) => s.x);
    expect(Math.min(...xs)).toBeLessThan(0.15);
    expect(Math.max(...xs)).toBeGreaterThan(0.85);
    const firstHalf = xs.filter((x) => x < 0.5).length;
    expect(firstHalf).toBeGreaterThan(10);
    expect(firstHalf).toBeLessThan(30);
  });

  test('phases differ, so they do not all pulse in step', () => {
    const phases = new Set(makeStars(20, seeded()).map((s) => s.phase));
    expect(phases.size).toBeGreaterThan(1);
  });

  test('asking for none gives none', () => {
    expect(makeStars(0, seeded())).toEqual([]);
  });
});

describe('makeClouds', () => {
  test('both of the footer skyline outlines get used', () => {
    const clouds = makeClouds(6, seeded());
    expect(clouds.some((c) => c.wide)).toBe(true);
    expect(clouds.some((c) => !c.wide)).toBe(true);
  });

  test('scales stay in a range that keeps them clouds, not smudges or walls', () => {
    for (const cloud of makeClouds(8, seeded())) {
      expect(cloud.scale).toBeGreaterThan(0.2);
      expect(cloud.scale).toBeLessThan(1);
    }
  });

  test('they sit inside the sky, spread across it', () => {
    const clouds = makeClouds(6, seeded());
    for (const cloud of clouds) {
      expect(cloud.x).toBeGreaterThanOrEqual(0);
      expect(cloud.x).toBeLessThan(1);
      expect(cloud.y).toBeGreaterThanOrEqual(0);
      expect(cloud.y).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...clouds.map((c) => c.x))).toBeGreaterThan(0.7);
  });
});

describe('cloud outlines', () => {
  test('both are closed paths, so a fill and a stroke both behave', () => {
    // A path left open would fill with a straight edge across the bottom.
    for (const path of [CLOUD_PUFFY, CLOUD_WIDE]) {
      expect(path.startsWith('M')).toBe(true);
      expect(path.trimEnd().endsWith('z')).toBe(true);
    }
  });
});
