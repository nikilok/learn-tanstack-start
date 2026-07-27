// The screensaver's parametric curve — one 10k-sample coil, drawn as sub-pixel dots.
// Model space is the original 400×400 sketch's coordinate system; the renderer fits it
// to whatever canvas it has (see `fitCoil`), so nothing here knows about the viewport.

const { cos, sin, sqrt, min, PI } = Math;
const TAU = PI * 2;

// Samples per frame. Fewer thins the coil out; more costs a path op each.
const SAMPLE_COUNT = 10_000;

/** Curve time per rendered frame in the source sketch — 320 frames (4π) is one exact cycle. */
export const TIME_STEP = PI / 80;

/** Curve time per real second: the sketch's per-frame step at 60fps, so a 120Hz display doesn't run it at double speed. */
export const TIME_PER_SECOND = TIME_STEP * 60;

/** Dot radius in model units — the sketch's 0.5px at scale 1, so density survives being scaled up. */
export const COIL_DOT_RADIUS = 0.5;

/** Fraction of the constraining viewport axis the whole-cycle envelope spans. Any one frame fills ~three quarters of that, so this has to run close to the edge for the coil to command the screen. */
export const COIL_FILL = 0.92;

/**
 * Box every sample stays inside across a full cycle, measured from `sampleCoil` and
 * locked by coil.test.ts. Fitting to the whole-cycle envelope rather than the current
 * frame's extent is what stops the coil pulsing in and out as it breathes.
 */
export const COIL_ENVELOPE = {
  centreX: 199.5,
  centreY: 213.5,
  width: 225,
  height: 337,
};

/**
 * Spine offset (`spread`) beyond which a sample is out on one of the creature's tentacles
 * rather than in its body. Around a quarter of the samples clear it, and that share holds
 * steady across the whole cycle, so the split never flickers.
 */
export const TENTACLE_SPREAD = 22;

/**
 * Walks the curve at time `t`, handing every sample to `emit` in model space along with
 * its `spread` — how far it is thrown from the spine, which is what separates the body
 * from the tentacles (`x` is offset from the spine by exactly `q`, and `y` by `q·sin c`).
 */
export function sampleCoil(
  t: number,
  emit: (x: number, y: number, spread: number) => void,
): void {
  for (let i = SAMPLE_COUNT - 1; i >= 0; i--) {
    const y = i / 235;
    const k = (4 + cos(i / 9 - t * 2)) * cos(i / 35);
    const e = y / 7 - 13;
    // sqrt, not Math.hypot: same result at these magnitudes, far cheaper 10k times a frame.
    const d = sqrt(k * k + e * e) + sin(e / 9 + t / 2) - 4;
    const q =
      2 * sin(k * 3) - (y / 35) * k * (9 + k * sin(cos(e) * 9 - d * 2 + t));
    const c = d - t;
    emit(q + 40 * cos(c) + 200, q * sin(c) + d * 35, q < 0 ? -q : q);
  }
}

/** Maps model space onto a `width`×`height` device-pixel canvas: multiply by `scale`, then add the offset. */
export function fitCoil(
  width: number,
  height: number,
  fill: number = COIL_FILL,
): { scale: number; offsetX: number; offsetY: number } {
  const scale =
    min(width / COIL_ENVELOPE.width, height / COIL_ENVELOPE.height) * fill;
  return {
    scale,
    offsetX: width / 2 - COIL_ENVELOPE.centreX * scale,
    offsetY: height / 2 - COIL_ENVELOPE.centreY * scale,
  };
}

/** The fitted envelope's corners in device px. A gradient spans these rather than the canvas, so its full range lands across the drawing instead of the empty field around it. */
export function coilBounds(
  scale: number,
  offsetX: number,
  offsetY: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const halfWidth = (COIL_ENVELOPE.width / 2) * scale;
  const halfHeight = (COIL_ENVELOPE.height / 2) * scale;
  const centreX = COIL_ENVELOPE.centreX * scale + offsetX;
  const centreY = COIL_ENVELOPE.centreY * scale + offsetY;
  return {
    x0: centreX - halfWidth,
    y0: centreY - halfHeight,
    x1: centreX + halfWidth,
    y1: centreY + halfHeight,
  };
}

// Drift amplitude as a fraction of the canvas's short side, and two periods that don't
// share a factor so the coil never retraces the same path.
const DRIFT_FRACTION = 0.025;
const DRIFT_X_PERIOD_S = 89;
const DRIFT_Y_PERIOD_S = 127;

/** Slow wander of the whole coil in device px — burn-in insurance for a screensaver that may sit for hours. */
export function coilDrift(
  elapsedMs: number,
  shortSide: number,
): { x: number; y: number } {
  const amplitude = shortSide * DRIFT_FRACTION;
  const seconds = elapsedMs / 1000;
  return {
    x: amplitude * sin((TAU * seconds) / DRIFT_X_PERIOD_S),
    y: amplitude * sin((TAU * seconds) / DRIFT_Y_PERIOD_S),
  };
}

// Per-dot alpha — the sketch's stroke(255, 96). Overlapping dots accumulate towards solid.
const DOT_ALPHA = 96 / 255;

// A mid-tone dot on white carries far less contrast than a pale one on near-black, so the
// light sweep needs more weight per dot to read as densely as the dark one does.
const LIGHT_DOT_ALPHA = 0.5;

/** rgba() string for a #rrggbb colour at a dot alpha. */
function dot(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Each sweep is drawn from the page's own background, at the depth that theme needs — the
// same trade --rail-spectrum makes in styles.css, where dark lifts its stops and light
// deepens them. Dark echoes the blue/violet glow grid (--link-blue, --bg-wash, --glow-b),
// which leaves the brand red room to carry the tentacles. Light has no such glow to echo,
// so it runs the warm half of --rail-spectrum itself — the same amber → pink → purple →
// blue the hero streaks and the guide-rail use. Keep the hues in step with those tokens.
const DARK_DOT_STOPS = ['#4f9dff', '#8b8ef7', '#b06cf0'];
const LIGHT_DOT_STOPS = ['#e2820e', '#e23b86', '#7b3fe4', '#2954d6'];

/**
 * Screensaver colours for the active theme, over the app's own page base (--bg-base in
 * styles.css — keep in sync). The stops are a sweep across the drawing, not a flat fill:
 * blue → indigo → violet on the dark page, amber → pink → purple → blue on the light one.
 * A lone dot lands as a pale tint and only the dense ribbons saturate to the full colour.
 * `tentacle`, when present, overrides the sweep for samples past `TENTACLE_SPREAD` — the
 * dark page runs the brand red out along the strands.
 */
export function coilPalette(dark: boolean): {
  background: string;
  dotStops: string[];
  tentacle?: string;
} {
  return dark
    ? {
        background: '#0a0a0a',
        dotStops: DARK_DOT_STOPS.map((hex) => dot(hex, DOT_ALPHA)),
        // --logo-red as dark mode renders it (styles.css), the shade the wordmark
        // already wears on this field. The light page keeps one unbroken sweep.
        tentacle: dot('#f87171', DOT_ALPHA),
      }
    : {
        background: '#ffffff',
        dotStops: LIGHT_DOT_STOPS.map((hex) => dot(hex, LIGHT_DOT_ALPHA)),
      };
}
