/**
 * The drawing space every other module in this package works in: the skyline's own
 * viewBox, with the landmarks standing on `GROUND_Y`. Consumers scale out of it — the
 * footer maps it to an SVG viewBox, the desktop game maps each landmark into an obstacle.
 */
export const VIEW_W = 1460;
export const VIEW_H = 600;
/** The line every landmark stands on. */
export const GROUND_Y = 600;

/** Rounds to 0.1 to keep generated path coordinates tidy in the DOM. */
export const r = (n: number) => Math.round(n * 10) / 10;

/** Rounds ink coordinates to whole units — sub-pixel at footer scale, and it
 * keeps the generated path data ~20% smaller in every SSR document. */
export const ri = (n: number) => Math.round(n);

/** Deterministic PRNG (mulberry32) so the generated ink matches across SSR and client. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
