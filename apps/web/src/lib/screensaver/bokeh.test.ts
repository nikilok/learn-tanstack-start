import { describe, expect, test } from 'bun:test';

import { bokehAt, BOKEH_COUNT, bokehField, bokehPalette } from './bokeh.ts';
import { DARK_DOT_STOPS, LIGHT_DOT_STOPS } from './coil.ts';

const field = bokehField();

/** Samples one highlight right across its focus travel. */
const track = (index: number, stepMs = 500, steps = 800) =>
  Array.from({ length: steps }, (_, i) =>
    bokehAt(field[index] as never, i * stepMs),
  );

describe('bokehField', () => {
  test('is the same field every time — the still frame must not be a lucky draw', () => {
    expect(bokehField()).toEqual(field);
  });

  test('places every highlight inside the frame', () => {
    expect(field).toHaveLength(BOKEH_COUNT);
    for (const p of field) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  test('spreads evenly — the point of the R2 sequence over an RNG', () => {
    // Every quadrant gets a share; random placement leaves bald patches at this count.
    const quadrants = [0, 0, 0, 0];
    for (const p of field) {
      quadrants[(p.x < 0.5 ? 0 : 1) + (p.y < 0.5 ? 0 : 2)]!++;
    }
    for (const count of quadrants) {
      expect(count).toBeGreaterThanOrEqual(BOKEH_COUNT / 4 - 2);
      expect(count).toBeLessThanOrEqual(BOKEH_COUNT / 4 + 2);
    }
  });

  test('sits mostly behind the coil, so only a minority ever cross in front', () => {
    const behind = field.filter((p) => p.focusBias < 0).length;
    expect(behind).toBeGreaterThan(BOKEH_COUNT * 0.55);
  });
});

describe('bokehAt — focus travel', () => {
  test('some highlights pass clean through focus and others never do', () => {
    // A swing wider than the bias reaches the focal plane; the rest stay defocused,
    // and that mix is what stops the field reading as one uniform effect.
    const crossers = field.filter((p) => Math.abs(p.focusBias) < p.focusSwing);
    expect(crossers.length).toBeGreaterThan(3);
    expect(field.length - crossers.length).toBeGreaterThan(3);

    // Sampled finely, a crosser really does come to a point and a non-crosser never does.
    const sharpest = (p: (typeof field)[number]) =>
      Math.min(
        ...Array.from({ length: 4000 }, (_, i) => bokehAt(p, i * 100).radius),
      );
    expect(sharpest(crossers[0] as never)).toBeLessThan(0.006);
    const stuck = field.find((p) => Math.abs(p.focusBias) >= p.focusSwing);
    expect(sharpest(stuck as never)).toBeGreaterThan(0.008);
  });

  test('a highlight tightening into focus brightens as it goes', () => {
    // Pick one that genuinely crosses, then check radius and alpha move opposite ways.
    const crossing = field.findIndex(
      (p) => Math.abs(p.focusBias) < p.focusSwing,
    );
    expect(crossing).toBeGreaterThanOrEqual(0);
    const samples = track(crossing);
    const tightest = samples.reduce((a, b) => (b.radius < a.radius ? b : a));
    const broadest = samples.reduce((a, b) => (b.radius > a.radius ? b : a));
    expect(tightest.alpha).toBeGreaterThan(broadest.alpha * 2);
  });

  test('keeps radius and alpha inside their range at all times', () => {
    for (const p of field) {
      for (let ms = 0; ms < 300_000; ms += 811) {
        const { radius, alpha } = bokehAt(p, ms);
        expect(radius).toBeGreaterThanOrEqual(0.0035);
        expect(radius).toBeLessThanOrEqual(0.028);
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThanOrEqual(0.56);
      }
    }
  });

  test('crossing the focal plane is also what swaps it across the coil', () => {
    const crossing = field.findIndex(
      (p) => Math.abs(p.focusBias) < p.focusSwing,
    );
    const sides = new Set(track(crossing).map((s) => s.front));
    expect(sides.size).toBe(2);
    // And it is at its smallest as it swaps, so the layer change can't pop.
    const samples = track(crossing);
    const swaps = samples.filter(
      (s, i) =>
        i > 0 &&
        s.front !== (samples[i - 1] as never as { front: boolean }).front,
    );
    for (const s of swaps) expect(s.radius).toBeLessThan(0.008);
  });
});

describe('bokehAt — drift and shimmer', () => {
  test('wanders on two axes rather than sliding along a line', () => {
    const path = track(0, 2000, 120).map((s) => ({ x: s.x, y: s.y }));
    const spanX =
      Math.max(...path.map((p) => p.x)) - Math.min(...path.map((p) => p.x));
    const spanY =
      Math.max(...path.map((p) => p.y)) - Math.min(...path.map((p) => p.y));
    expect(spanX).toBeGreaterThan(0.02);
    expect(spanY).toBeGreaterThan(0.02);
  });

  test('never strays far from where it was placed', () => {
    for (const p of field) {
      for (let ms = 0; ms < 400_000; ms += 2003) {
        const { x, y } = bokehAt(p, ms);
        expect(Math.abs(x - p.x)).toBeLessThanOrEqual(0.061);
        expect(Math.abs(y - p.y)).toBeLessThanOrEqual(0.061);
      }
    }
  });

  test('the field never pulses as one', () => {
    const at = (ms: number) => field.map((p) => bokehAt(p, ms).alpha);
    const first = at(9_000);
    const later = at(21_000);
    const rose = first.filter((a, i) => (later[i] as number) > a).length;
    expect(rose).toBeGreaterThan(2);
    expect(rose).toBeLessThan(field.length - 2);
  });

  test('settles to one fixed frame at rest, for reduced motion', () => {
    expect(bokehAt(field[0] as never, 0)).toEqual(
      bokehAt(field[0] as never, 0),
    );
    // Each highlight starts part-way into its own drift cycle, so t=0 is offset from
    // its placement — but bounded by it, which is what keeps the still frame composed.
    for (const p of field) {
      const { x, y } = bokehAt(p, 0);
      expect(Math.abs(x - p.x)).toBeLessThanOrEqual(0.061);
      expect(Math.abs(y - p.y)).toBeLessThanOrEqual(0.061);
    }
  });
});

describe('bokehPalette', () => {
  test('borrows the coil’s own hues, so the two can never drift apart', () => {
    for (const hex of DARK_DOT_STOPS) {
      expect(bokehPalette(true).colours).toContain(hex);
    }
    expect(bokehPalette(false).colours).toEqual(LIGHT_DOT_STOPS);
  });

  test('adds light on the dark page and lays colour down on the light one', () => {
    // `lighter` on a near-white page would be invisible.
    expect(bokehPalette(true).composite).toBe('lighter');
    expect(bokehPalette(false).composite).toBe('source-over');
    expect(bokehPalette(false).gain).toBeLessThan(bokehPalette(true).gain);
  });
});
