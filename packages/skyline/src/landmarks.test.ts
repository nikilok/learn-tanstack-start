import { describe, expect, test } from 'bun:test';

import { CLOUDS, INK_STROKES, STARS, SUN_RAYS } from './index.ts';
import { LANDMARKS, LANDMARK_ORDER } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';
import { GROUND_Y, VIEW_W } from './units.ts';

const all = Object.values(LANDMARKS) as Landmark[];

describe('landmarks', () => {
  test('every one stands on the ground line', () => {
    // The whole reason the bounding box is written down: the game lands a landmark by
    // putting the bottom of its box on the road. A box that stops short of the ground
    // line leaves it hovering, and one that runs past it sinks it into the surface —
    // neither of which shows up anywhere in the footer, where the SVG clips at the seam.
    for (const l of all) expect(l.y + l.h).toBe(GROUND_Y);
  });

  test('every box sits inside the sky it is drawn in', () => {
    for (const l of all) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x + l.w).toBeLessThanOrEqual(VIEW_W);
      expect(l.w).toBeGreaterThan(0);
      expect(l.h).toBeGreaterThan(0);
    }
  });

  test('the drawing order names every landmark exactly once', () => {
    expect([...LANDMARK_ORDER].sort()).toEqual(Object.keys(LANDMARKS).sort());
  });

  test('every landmark has line work, and its id matches its key', () => {
    for (const [key, l] of Object.entries(LANDMARKS)) {
      expect(l.id).toBe(key as Landmark['id']);
      expect(l.marks.length).toBeGreaterThan(0);
      for (const m of l.marks) expect(m.d.length).toBeGreaterThan(0);
    }
  });

  test('a clipped mark clips to a path the landmark actually draws', () => {
    // A clip referring to a shape that is not in the set would silently erase the mark
    // in one renderer and not the other.
    for (const l of all) {
      const drawn = new Set(l.marks.map((m) => m.d));
      for (const m of l.marks) {
        if (m.clip) expect(drawn.has(m.clip)).toBe(true);
      }
    }
  });
});

describe('sky', () => {
  test('the ink sweep is generated, seeded and non-empty', () => {
    expect(INK_STROKES).toHaveLength(5);
    for (const s of INK_STROKES) {
      expect(s.d.length).toBeGreaterThan(100);
      expect(s.opacity).toBeGreaterThan(0);
    }
    // Only the body may use evenodd — on the spatter paths it would erase overlapping
    // dots into white lenses instead of merging them.
    expect(INK_STROKES.filter((s) => s.fillRule === 'evenodd')).toHaveLength(1);
  });

  test('the celestial shapes are all there', () => {
    expect(SUN_RAYS).toHaveLength(12);
    expect(STARS).toHaveLength(7);
    expect(CLOUDS).toHaveLength(3);
  });
});
