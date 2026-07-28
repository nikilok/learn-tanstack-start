import { describe, expect, test } from 'bun:test';

import {
  COIL_ENVELOPE,
  COIL_FILL,
  coilBounds,
  coilDrift,
  coilPalette,
  fitCoil,
  sampleCoil,
  TIME_PER_SECOND,
  TENTACLE_SPREAD,
  TIME_STEP,
} from './coil.ts';

/** Bounding box of every sample across `frames` evenly-spaced times spanning one cycle. */
function measure(frames: number) {
  const box = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  for (let f = 0; f < frames; f++) {
    // Off the exact per-frame grid, so the envelope holds for continuous time too.
    const t = (f / frames) * 4 * Math.PI + 0.013;
    sampleCoil(t, (x, y) => {
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
    });
  }
  return box;
}

describe('sampleCoil', () => {
  test('emits the full sample set', () => {
    let count = 0;
    sampleCoil(1.5, () => {
      count++;
    });
    expect(count).toBe(10_000);
  });

  test('splits body from tentacles at a share that holds all cycle', () => {
    // The two passes in ScreenSaver are only flicker-free because this stays put.
    const shares: number[] = [];
    for (let f = 0; f < 24; f++) {
      let tentacles = 0;
      sampleCoil((f / 24) * 4 * Math.PI, (_x, _y, spread) => {
        if (spread >= TENTACLE_SPREAD) tentacles++;
      });
      shares.push(tentacles / 10_000);
    }
    expect(Math.min(...shares)).toBeGreaterThan(0.15);
    expect(Math.max(...shares)).toBeLessThan(0.35);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThan(0.05);
  });

  test('spread is the sample offset from the spine, never negative', () => {
    sampleCoil(2.4, (_x, _y, spread) => {
      expect(spread).toBeGreaterThanOrEqual(0);
    });
  });

  test('repeats exactly after 4π — the 320-frame cycle', () => {
    expect(TIME_STEP * 320).toBeCloseTo(4 * Math.PI, 12);
    const first: number[] = [];
    sampleCoil(0.7, (x, y) => {
      first.push(x, y);
    });
    const second: number[] = [];
    sampleCoil(0.7 + 4 * Math.PI, (x, y) => {
      second.push(x, y);
    });
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBeCloseTo(first[i] as number, 6);
    }
  });

  test('runs at the source sketch speed', () => {
    expect(TIME_PER_SECOND).toBeCloseTo(TIME_STEP * 60, 12);
  });
});

describe('COIL_ENVELOPE', () => {
  const box = measure(160);
  const left = COIL_ENVELOPE.centreX - COIL_ENVELOPE.width / 2;
  const right = COIL_ENVELOPE.centreX + COIL_ENVELOPE.width / 2;
  const top = COIL_ENVELOPE.centreY - COIL_ENVELOPE.height / 2;
  const bottom = COIL_ENVELOPE.centreY + COIL_ENVELOPE.height / 2;

  test('contains every sample of a full cycle', () => {
    expect(box.minX).toBeGreaterThanOrEqual(left);
    expect(box.maxX).toBeLessThanOrEqual(right);
    expect(box.minY).toBeGreaterThanOrEqual(top);
    expect(box.maxY).toBeLessThanOrEqual(bottom);
  });

  test('stays tight around them — the fit would waste screen otherwise', () => {
    expect(box.maxX - box.minX).toBeGreaterThan(COIL_ENVELOPE.width * 0.95);
    expect(box.maxY - box.minY).toBeGreaterThan(COIL_ENVELOPE.height * 0.95);
  });
});

describe('fitCoil', () => {
  test('centres the envelope in the canvas', () => {
    const { scale, offsetX, offsetY } = fitCoil(1920, 1080);
    expect(COIL_ENVELOPE.centreX * scale + offsetX).toBeCloseTo(960, 6);
    expect(COIL_ENVELOPE.centreY * scale + offsetY).toBeCloseTo(540, 6);
  });

  test('fills the constraining axis and leaves the rest as margin', () => {
    // Landscape: the tall coil is height-bound, so height decides the scale.
    const wide = fitCoil(1920, 1080);
    expect(COIL_ENVELOPE.height * wide.scale).toBeCloseTo(1080 * COIL_FILL, 6);
    expect(COIL_ENVELOPE.width * wide.scale).toBeLessThan(1920 * COIL_FILL);
    // Narrow portrait phone: width becomes the constraint instead.
    const tall = fitCoil(390, 844);
    expect(COIL_ENVELOPE.width * tall.scale).toBeCloseTo(390 * COIL_FILL, 6);
  });

  test('never clips — the fitted coil sits inside the canvas', () => {
    const sizes: Array<[number, number]> = [
      [1920, 1080],
      [390, 844],
      [800, 800],
      [2560, 1440],
    ];
    for (const [w, h] of sizes) {
      const { scale, offsetX, offsetY } = fitCoil(w, h);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      sampleCoil(2.1, (x, y) => {
        const px = x * scale + offsetX;
        const py = y * scale + offsetY;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      });
      expect(minX).toBeGreaterThanOrEqual(0);
      expect(maxX).toBeLessThanOrEqual(w);
      expect(minY).toBeGreaterThanOrEqual(0);
      expect(maxY).toBeLessThanOrEqual(h);
    }
  });
});

describe('coilBounds', () => {
  test('is the fitted envelope, so a gradient spans the drawing not the field', () => {
    const { scale, offsetX, offsetY } = fitCoil(1920, 1080);
    const { x0, y0, x1, y1 } = coilBounds(scale, offsetX, offsetY);
    expect(x1 - x0).toBeCloseTo(COIL_ENVELOPE.width * scale, 6);
    expect(y1 - y0).toBeCloseTo(COIL_ENVELOPE.height * scale, 6);
    expect((x0 + x1) / 2).toBeCloseTo(960, 6);
    expect((y0 + y1) / 2).toBeCloseTo(540, 6);
  });

  test('tracks the drift offset it is given', () => {
    const { scale, offsetX, offsetY } = fitCoil(1920, 1080);
    const still = coilBounds(scale, offsetX, offsetY);
    const drifted = coilBounds(scale, offsetX + 20, offsetY - 12);
    expect(drifted.x0 - still.x0).toBeCloseTo(20, 6);
    expect(drifted.y1 - still.y1).toBeCloseTo(-12, 6);
  });
});

describe('coilDrift', () => {
  test('starts centred and stays within the amplitude', () => {
    expect(coilDrift(0, 1000)).toEqual({ x: 0, y: 0 });
    for (let ms = 0; ms < 600_000; ms += 971) {
      const { x, y } = coilDrift(ms, 1000);
      expect(Math.abs(x)).toBeLessThanOrEqual(25);
      expect(Math.abs(y)).toBeLessThanOrEqual(25);
    }
  });

  test('the two axes stay out of phase, so it never retraces one line', () => {
    // Equal offsets on both axes would mean a diagonal path; 40s in they differ.
    const { x, y } = coilDrift(40_000, 1000);
    expect(Math.abs(x - y)).toBeGreaterThan(1);
  });
});

describe('coilPalette', () => {
  test('sweeps the dark page blue → indigo → violet, with brand red on the tentacles', () => {
    const { dotStops, tentacle } = coilPalette(true);
    expect(dotStops).toEqual([
      `rgba(79, 157, 255, ${96 / 255})`,
      `rgba(139, 142, 247, ${96 / 255})`,
      `rgba(176, 108, 240, ${96 / 255})`,
    ]);
    expect(tentacle).toBe(`rgba(248, 113, 113, ${96 / 255})`);
  });

  test('leaves the light page one unbroken sweep', () => {
    expect(coilPalette(false).tentacle).toBeUndefined();
  });

  test('runs the rail spectrum across the light page, amber → pink → purple → blue', () => {
    const { dotStops } = coilPalette(false);
    expect(dotStops).toEqual([
      'rgba(226, 130, 14, 0.5)',
      'rgba(226, 59, 134, 0.5)',
      'rgba(123, 63, 228, 0.5)',
      'rgba(41, 84, 214, 0.5)',
    ]);
  });

  test('every stop carries its theme alpha, so overlaps still accumulate', () => {
    for (const stop of [
      ...coilPalette(true).dotStops,
      coilPalette(true).tentacle,
    ]) {
      expect(stop).toEndWith(`, ${96 / 255})`);
    }
    // Mid-tone dots on white need more weight than pale dots on near-black.
    for (const stop of coilPalette(false).dotStops) {
      expect(stop).toEndWith(', 0.5)');
    }
  });
});
