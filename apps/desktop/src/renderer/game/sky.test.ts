import { describe, expect, test } from 'bun:test';

import { makeClouds, makeStars } from './sky.ts';

/** Deterministic stand-in for Math.random, cycling through a fixed spread. */
function seeded(): () => number {
  const values = [0.05, 0.61, 0.27, 0.94, 0.42, 0.78, 0.13, 0.86, 0.35, 0.7];
  let i = 0;
  return () => values[i++ % values.length] as number;
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
  test('each cloud is a cluster of puffs, wider than it is tall', () => {
    for (const cloud of makeClouds(6, seeded())) {
      expect(cloud.puffs.length).toBeGreaterThanOrEqual(3);
      expect(cloud.scale).toBeGreaterThan(0);
      const spread = Math.max(...cloud.puffs.map((p) => Math.abs(p.dx)));
      const rise = Math.max(...cloud.puffs.map((p) => Math.abs(p.dy)));
      expect(spread).toBeGreaterThan(rise);
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
