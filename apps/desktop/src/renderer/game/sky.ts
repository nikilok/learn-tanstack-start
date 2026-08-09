/**
 * The scenery behind the runner: a star field at night, clouds by day. Positions are
 * generated once and held in normalised 0..1 space, so a resize re-uses the same sky
 * instead of shuffling it, and the canvas only has to multiply by its own size.
 *
 * Pure — the caller passes the randomness in — so the layout rules are unit-testable and
 * RunnerCanvas.tsx is left with nothing but drawing.
 */

export interface Star {
  x: number; // 0..1 across the sky
  y: number; // 0..1 down the sky's band
  r: number; // radius in px
  /** Where in its own twinkle cycle this star starts, so they don't all pulse together. */
  phase: number;
  /** The few brightest get drawn with a sparkle rather than as a plain dot. */
  bright: boolean;
}

export interface Puff {
  dx: number; // offsets from the cloud's anchor, in units of its own radius
  dy: number;
  r: number;
}

export interface Cloud {
  x: number; // 0..1 across the sky
  y: number; // 0..1 down the sky's band
  scale: number; // px radius of the cloud's main body
  puffs: Puff[];
}

/**
 * A star field. Columns are spread evenly and jittered rather than placed at random, which
 * is what stops a purely random field from clumping into patches and bald spots.
 */
export function makeStars(count: number, rnd: () => number): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const lane = (i + rnd() * 0.85) / count;
    stars.push({
      x: Math.min(0.999, lane),
      y: rnd() ** 1.4, // biased upward: the horizon stays clearer than the top of the sky
      r: 0.6 + rnd() * 1.1,
      phase: rnd() * Math.PI * 2,
      bright: rnd() < 0.16,
    });
  }
  return stars;
}

/** A handful of clouds, each a cluster of overlapping puffs around its own anchor. */
export function makeClouds(count: number, rnd: () => number): Cloud[] {
  const clouds: Cloud[] = [];
  for (let i = 0; i < count; i++) {
    const puffs: Puff[] = [];
    const n = 3 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) {
      puffs.push({
        // Spread along the body and kept low, so a cloud reads as wider than it is tall.
        dx: (j / Math.max(1, n - 1) - 0.5) * 2.2,
        dy: -rnd() * 0.45,
        r: 0.55 + rnd() * 0.5,
      });
    }
    clouds.push({
      x: Math.min(0.999, (i + rnd() * 0.8) / count),
      y: rnd() ** 1.5,
      scale: 12 + rnd() * 12,
      puffs,
    });
  }
  return clouds;
}
