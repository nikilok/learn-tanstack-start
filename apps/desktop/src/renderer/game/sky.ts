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

/**
 * The two cloud outlines the site's own footer skyline draws — a puffy three-bump and a
 * wide four-bump — so the game's day sky is the same weather as the footer's. Canvas takes
 * SVG path data directly through Path2D.
 */
export { CLOUD_PUFFY, CLOUD_WIDE } from '@ss/skyline';

export interface Cloud {
  x: number; // 0..1 across the sky
  y: number; // 0..1 down the sky's band
  scale: number; // multiplier on the path's own ~120-unit width
  /** Which of the two outlines to draw. */
  wide: boolean;
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

/** A handful of clouds, alternating the two outlines and spread across the sky. */
export function makeClouds(count: number, rnd: () => number): Cloud[] {
  const clouds: Cloud[] = [];
  for (let i = 0; i < count; i++) {
    clouds.push({
      x: Math.min(0.999, (i + rnd() * 0.8) / count),
      y: rnd() ** 1.5,
      scale: 0.34 + rnd() * 0.26,
      wide: i % 2 === 1,
    });
  }
  return clouds;
}
