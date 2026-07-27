// Out-of-focus highlights drifting around the coil, to sit it in a volume rather than on a
// flat plane. The field is deterministic — an R2 low-discrepancy sequence rather than an
// RNG — so it spreads evenly without the clumps and bald patches random placement gives,
// and so the reduced-motion still frame is a composed picture instead of a lucky one.
//
// Each highlight has a DEPTH that travels slowly through the focal plane, and everything
// else follows from it: |depth| is the circle of confusion (0 = pin sharp), so the disc
// swells as it goes out of focus and tightens to a point as it comes in. Its brightness is
// the same light spread over that disc, so tightening also brightens. And the sign of the
// depth decides whether it passes in front of the coil or behind it. One number, one
// coherent piece of physics — not three effects animated to look related.

import { DARK_DOT_STOPS, LIGHT_DOT_STOPS, TENTACLE_HEX } from './coil';

const { sin, cos, abs, min, floor, PI } = Math;
const TAU = PI * 2;

// Plastic number: 1/g and 1/g² generate the R2 sequence, the 2D analogue of the golden
// ratio, which is about as evenly as points can be scattered without forming a grid.
const PLASTIC = 1.324717957244746;
const R2_X = 1 / PLASTIC;
const R2_Y = 1 / (PLASTIC * PLASTIC);
// Separate irrationals per attribute, so depth and shimmer don't correlate with position.
// These must stay mutually independent AND independent of R2_X/R2_Y above — `frac(i × a)`
// and `frac(i × b)` are the SAME sequence whenever a − b is an integer, so a step that
// merely looks different can still be an exact function of the placement. bokeh.test.ts
// locks the resulting independence rather than the constants.
const SEED_STEP = 0.6180339887498949; // 1/φ
const BIAS_STEP = Math.SQRT2; // 1.4142…
const SWING_STEP = Math.E - 2; // 0.7182…, transcendental and unrelated to the above

/** How many highlights the field holds. One `drawImage` each, so it costs nothing beside the coil's 10k dots. */
export const BOKEH_COUNT = 32;

// Disc radius as a fraction of the canvas's short side, from pin-sharp to fully bloomed.
// These are small on purpose: the coil is the subject, and highlights that rival it in
// size stop reading as depth and start reading as spots on the lens.
const MIN_RADIUS = 0.0035;
const MAX_RADIUS = 0.028;

/** Opacity of a perfectly focused highlight, before the per-theme gain. */
const PEAK_ALPHA = 0.55;

// How hard brightness tracks the disc size. True inverse-square is too violent to look at,
// so the falloff is softened — a fully bloomed disc still lands around a quarter of peak.
const CONCENTRATION = 0.75;

// Depth: the slow travel through focus. Bias is where a highlight sits on average, swing
// how far it moves; a swing wider than the bias means it passes clean through the focal
// plane, and those are the ones that sparkle. The range is weighted behind the coil so
// only a minority ever cross in front of it.
const MIN_BIAS = -1;
const MAX_BIAS = 0.45;
const MIN_SWING = 0.25;
const MAX_SWING = 0.9;
const MIN_FOCUS_HZ = 0.008; // ~125s to travel a full cycle
const MAX_FOCUS_HZ = 0.03; // ~33s

// Shimmer on top of the focus travel — kept shallow, so focus stays the dominant motion.
const MIN_SHIMMER_HZ = 0.05;
const MAX_SHIMMER_HZ = 0.14;
const SHIMMER_DEPTH = 0.35;

// Drift: a two-axis wander, each axis on its own period so highlights roam rather than
// slide back and forth along a line.
const DRIFT_FRACTION = 0.06;
const MIN_DRIFT_PERIOD_S = 55;
const MAX_DRIFT_PERIOD_S = 145;

export interface BokehParticle {
  /** Placement in the frame as a fraction of the canvas. The drift wanders around this, and starts part-way into its cycle, so it is the centre of the wander rather than where the highlight sits at t=0. */
  x: number;
  y: number;
  /** Index into the palette's colours. */
  colour: number;
  /** Drives this highlight's drift periods and shimmer. */
  seed: number;
  /** Depth it sits at on average: -1 well behind the coil, +1 well in front, 0 in focus. */
  focusBias: number;
  /** How far through depth it travels. Wider than |focusBias| and it passes through focus. */
  focusSwing: number;
  /** Depth cycles per second. */
  focusRate: number;
}

/** Live state of one highlight. Position and radius are canvas fractions; alpha is before the per-theme gain. */
export interface BokehSample {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  /** True while it is on the near side of the focal plane, so it draws over the coil. */
  front: boolean;
}

/** Fractional part — the Weyl/R2 sequences below are all `frac(i × irrational)`. */
function frac(value: number): number {
  return value - floor(value);
}

/** Lays out the highlight field. Same input, same field, every time. */
export function bokehField(count: number = BOKEH_COUNT): BokehParticle[] {
  const field: BokehParticle[] = [];
  for (let i = 1; i <= count; i++) {
    const seed = frac(i * SEED_STEP);
    field.push({
      x: frac(0.5 + R2_X * i),
      y: frac(0.5 + R2_Y * i),
      colour: i % 4,
      seed,
      focusBias: MIN_BIAS + (MAX_BIAS - MIN_BIAS) * frac(i * BIAS_STEP),
      focusSwing: MIN_SWING + (MAX_SWING - MIN_SWING) * frac(i * SWING_STEP),
      focusRate: MIN_FOCUS_HZ + (MAX_FOCUS_HZ - MIN_FOCUS_HZ) * seed,
    });
  }
  return field;
}

/** Where a highlight is, how far out of focus, and how bright, at `elapsedMs`. */
export function bokehAt(
  particle: BokehParticle,
  elapsedMs: number,
): BokehSample {
  const { seed, focusBias, focusSwing, focusRate } = particle;
  const seconds = elapsedMs / 1000;

  const depth =
    focusBias + focusSwing * sin(TAU * (focusRate * seconds + seed));
  // Circle of confusion: zero at the focal plane, widening either side of it.
  const blur = min(1, abs(depth));
  const radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * blur;

  const rate = MIN_SHIMMER_HZ + (MAX_SHIMMER_HZ - MIN_SHIMMER_HZ) * seed;
  const pulse = 0.5 + 0.5 * sin(TAU * (rate * seconds + seed));
  const shimmer = 1 - SHIMMER_DEPTH + SHIMMER_DEPTH * pulse;

  const periodX =
    MIN_DRIFT_PERIOD_S + (MAX_DRIFT_PERIOD_S - MIN_DRIFT_PERIOD_S) * seed;
  const periodY =
    MAX_DRIFT_PERIOD_S - (MAX_DRIFT_PERIOD_S - MIN_DRIFT_PERIOD_S) * seed;

  return {
    x: particle.x + DRIFT_FRACTION * sin(TAU * (seconds / periodX + seed)),
    y: particle.y + DRIFT_FRACTION * cos(TAU * (seconds / periodY + seed)),
    radius,
    // The same light over a bigger disc is dimmer, so coming into focus brightens it.
    alpha: PEAK_ALPHA * (MIN_RADIUS / radius) ** CONCENTRATION * shimmer,
    front: depth > 0,
  };
}

/**
 * Highlight colours and blend for the active theme, drawn from the coil's own hues so the
 * field can't drift away from it. Dark adds light (`lighter`), which is what a real
 * defocused highlight does; on a near-white page that would be invisible, so light lays
 * soft colour down instead and pulls the strength back to suit.
 */
export function bokehPalette(dark: boolean): {
  colours: string[];
  composite: 'lighter' | 'source-over';
  gain: number;
} {
  return dark
    ? {
        colours: [...DARK_DOT_STOPS, TENTACLE_HEX],
        composite: 'lighter',
        gain: 1,
      }
    : { colours: LIGHT_DOT_STOPS, composite: 'source-over', gain: 0.55 };
}

// Sprite side in px. Highlights are scaled from this and they are meant to be soft, so it
// only has to be big enough that the gradient doesn't band at the largest bloom.
const SPRITE_PX = 128;

// Profile of one defocused disc: a near-flat core, then a slightly brighter rim before the
// falloff. That rim is the whole tell — without it this reads as a blurred dot, with it as
// a highlight thrown out of focus by a lens. Overall strength comes from globalAlpha, so
// these stay near opaque and only describe the shape.
const DISC_STOPS: Array<[number, number]> = [
  [0, 0.88],
  [0.5, 0.82],
  [0.85, 1],
  [1, 0],
];

/** Pre-renders one disc per colour. Blitting these each frame is far cheaper than building a radial gradient per highlight per frame. */
export function bokehSprites(
  colours: string[],
  paint: (hex: string, alpha: number) => string,
): HTMLCanvasElement[] {
  return colours.map((hex) => {
    const canvas = document.createElement('canvas');
    canvas.width = SPRITE_PX;
    canvas.height = SPRITE_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    const half = SPRITE_PX / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    for (const [offset, alpha] of DISC_STOPS) {
      gradient.addColorStop(offset, paint(hex, alpha));
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    return canvas;
  });
}
