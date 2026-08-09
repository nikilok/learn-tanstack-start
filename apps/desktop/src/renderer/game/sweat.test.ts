import { describe, expect, test } from 'bun:test';

import { PLAYER_R } from './runner.ts';
import { sweatCount, sweatDrops } from './sweat.ts';

const R = PLAYER_R; // the radius the canvas actually passes to sweatDrops

describe('sweatCount', () => {
  test('a fresh run is not sweating', () => {
    // The whole point is that it reads as earned; beads on the first jump say nothing.
    for (const score of [0, 1, 50, 119]) expect(sweatCount(score)).toBe(0);
  });

  test('it starts with a single bead, not a burst', () => {
    expect(sweatCount(120)).toBe(1);
    expect(sweatCount(150)).toBe(1);
  });

  test('it never eases off once it has started', () => {
    let previous = 0;
    for (let score = 0; score <= 2000; score += 25) {
      const now = sweatCount(score);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  test('it tops out rather than turning into a fountain', () => {
    const capped = sweatCount(700);
    for (const score of [700, 5_000, 100_000, 1e9]) {
      expect(sweatCount(score)).toBe(capped);
    }
    expect(capped).toBeLessThanOrEqual(5);
  });
});

describe('sweatDrops', () => {
  test('there are as many beads as the count says', () => {
    for (const score of [0, 120, 400, 900]) {
      expect(sweatDrops(1234, score, R)).toHaveLength(sweatCount(score));
    }
  });

  test('every bead leaves the rim and travels away from it', () => {
    // Pinned because the beads are drawn in the lens's own space: launch them from the
    // centre instead of the rim and they appear over its face rather than off its brow.
    const from = (dist: number) => sweatDrops(dist, 900, R);
    for (const d of from(0)) {
      const out = Math.hypot(d.x, d.y);
      expect(out).toBeGreaterThan(R * 0.5);
      expect(d.y).toBeLessThan(0); // up off the head, not down through the body
    }
    // Sampled across a whole flight, nothing ever ends up implausibly far away.
    for (let dist = 0; dist < 3000; dist += 37) {
      for (const d of from(dist)) {
        expect(Math.hypot(d.x, d.y)).toBeLessThan(R * 3);
      }
    }
  });

  test('life stays in range, which is what the fade is drawn from', () => {
    for (let dist = -500; dist < 3000; dist += 31) {
      for (const d of sweatDrops(dist, 900, R)) {
        expect(d.life).toBeGreaterThanOrEqual(0);
        expect(d.life).toBeLessThan(1);
      }
    }
  });

  test('the beads are staggered, not flicked all at once', () => {
    const lives = sweatDrops(500, 900, R).map((d) => d.life);
    expect(new Set(lives.map((l) => l.toFixed(3))).size).toBe(lives.length);
  });

  test('a standing still run does not move them', () => {
    expect(sweatDrops(800, 900, R)).toEqual(sweatDrops(800, 900, R));
  });
});
