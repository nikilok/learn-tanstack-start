/**
 * The sumi-e sky: a brush sweep behind the skyline, built as filled path data rather than
 * strokes so it can be painted by an SVG `<path>` or a canvas `Path2D` without change.
 * Every mark comes off a seeded PRNG, so SSR and client — and the site and the desktop
 * app — generate the identical sky.
 */
import { edgeAngleAt, edgeYAt } from './stations.ts';
import { mulberry32, ri, r } from './units.ts';

/** Thin tapered sliver from (x, y) along `angle` — a bristle mark or comb gap. */
function sliver(
  x: number,
  y: number,
  angle: number,
  len: number,
  w: number,
  bow: number,
): string {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const nx = -uy;
  const ny = ux;
  const tx = x + ux * len;
  const ty = y + uy * len;
  const cx = x + ux * len * 0.5 + nx * bow;
  const cy = y + uy * len * 0.5 + ny * bow;
  return `M${ri(x + nx * w)},${ri(y + ny * w)} Q${ri(cx + nx * w)},${ri(cy + ny * w)} ${ri(tx)},${ri(ty)} Q${ri(cx - nx * w)},${ri(cy - ny * w)} ${ri(x - nx * w)},${ri(y - ny * w)} Z`;
}

/** Irregular splot: a jittered ring joined with quadratic segments. */
function splot(rand: () => number, cx: number, cy: number, rBase: number) {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const rad = rBase * (0.6 + rand() * 0.8);
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  const mid = (p: [number, number], q: [number, number]) =>
    `${ri((p[0] + q[0]) / 2)},${ri((p[1] + q[1]) / 2)}`;
  let d = `M${mid(pts[5], pts[0])}`;
  for (let i = 0; i < 6; i++) {
    const p = pts[i];
    d += ` Q${ri(p[0])},${ri(p[1])} ${mid(p, pts[(i + 1) % 6])}`;
  }
  return `${d} Z`;
}

/** Seeded 1-D value noise over x, smoothstep-blended between lattice points. */
function makeNoise(rand: () => number, wavelength: number, amplitude: number) {
  const n = Math.ceil(1460 / wavelength) + 2;
  const lattice = Array.from({ length: n }, () => rand() - 0.5);
  return (x: number) => {
    const t = Math.max(0, x / wavelength);
    const i = Math.min(n - 2, Math.floor(t));
    const f = Math.min(1, t - i);
    const s = f * f * (3 - 2 * f);
    return (lattice[i] + (lattice[i + 1] - lattice[i]) * s) * 2 * amplitude;
  };
}

/** Ragged sweep body: noisy sampled edges with bristle nicks, plus dry-brush
 * comb gaps (evenodd holes) running parallel to the flanks. */
function buildInkBody(): string {
  const rand = mulberry32(0x5eed);
  const coarseTop = makeNoise(rand, 90, 7);
  const fineTop = makeNoise(rand, 22, 3);
  const coarseBot = makeNoise(rand, 80, 9);
  const fineBot = makeNoise(rand, 20, 4);
  const pts: string[] = [];
  for (let x = 66; x <= 1450; x += 12) {
    let y = edgeYAt(x, 1) + coarseTop(x) + fineTop(x);
    if (rand() < 0.12) y -= 5 + rand() * 9;
    pts.push(`${ri(x)},${ri(y)}`);
  }
  // right terminus: torn, not straight — jittered walk down with inward notches
  for (let y = 52; y <= 172; y += 11) {
    let x = 1451 + (rand() - 0.5) * 7;
    if (rand() < 0.3) x -= 10 + rand() * 16;
    pts.push(`${ri(x)},${ri(y + (rand() - 0.5) * 4)}`);
  }
  for (let x = 1450; x >= 66; x -= 12) {
    let y = edgeYAt(x, 2) + coarseBot(x) + fineBot(x);
    if (rand() < 0.16) y += 5 + rand() * 11;
    pts.push(`${ri(x)},${ri(y)}`);
  }
  let d = `M${pts[0]} L${pts.slice(1).join(' ')} Z`;
  // comb gaps: [x0, x1, edge, inset0, inset1, count, len0, len1]
  const zones: Array<
    [number, number, 1 | 2, number, number, number, number, number]
  > = [
    [950, 1210, 1, 12, 42, 5, 80, 170],
    [120, 320, 1, 12, 38, 4, 60, 130],
    [620, 900, 2, 12, 32, 3, 90, 180],
    [1230, 1400, 1, 14, 40, 3, 60, 120],
    [1280, 1442, 1, 44, 92, 4, 50, 110],
  ];
  for (const [x0, x1, edge, in0, in1, count, len0, len1] of zones) {
    for (let k = 0; k < count; k++) {
      const x = x0 + ((x1 - x0) * (k + rand() * 0.6)) / count;
      const out = edge === 1 ? 1 : -1;
      const y = edgeYAt(x, edge) + out * (in0 + rand() * (in1 - in0));
      const angle = edgeAngleAt(x, edge) + (rand() - 0.5) * 0.12;
      let len = len0 + rand() * (len1 - len0);
      // cap tips left of the torn terminus — outside the body, evenodd would
      // paint these gaps as solid streaks
      const ux = Math.cos(angle);
      if (ux > 0) len = Math.min(len, (1408 - x) / ux);
      if (len < 24) continue;
      d += ` ${sliver(x, y, angle, len, 1.6 + rand() * 1.8, (rand() - 0.5) * 10)}`;
    }
  }
  return d;
}

/** Bristle filaments fanning off the sweep's edges along the local tangent,
 * split into two bundles so they can layer at different opacities. */
function buildInkFilaments(): [string, string] {
  const rand = mulberry32(0xb1e55);
  // [x0, x1, edge, count]
  const zones: Array<[number, number, 1 | 2, number]> = [
    [80, 330, 1, 18],
    [1130, 1452, 1, 24],
    [20, 150, 2, 10],
    [600, 920, 2, 12],
    [1240, 1452, 2, 14],
  ];
  const bundles: [string[], string[]] = [[], []];
  for (const [x0, x1, edge, count] of zones) {
    for (let k = 0; k < count; k++) {
      const x = x0 + (x1 - x0) * ((k + rand()) / count);
      const out = edge === 1 ? -1 : 1;
      const y = edgeYAt(x, edge) + out * (1 + rand() * 4);
      const angle = edgeAngleAt(x, edge) + out * (0.05 + rand() * 0.12);
      let len = 14 + rand() * rand() * 80;
      // cap tips inside the viewBox — overshoot clips to a razor-straight edge
      const ux = Math.cos(angle);
      if (ux > 0) len = Math.min(len, (1455 - x) / ux);
      if (len < 6) continue;
      const mark = sliver(
        x,
        y,
        angle,
        len,
        0.8 + rand() * 1.4,
        out * (2 + rand() * 7),
      );
      bundles[rand() < 0.5 ? 0 : 1].push(mark);
    }
  }
  return [bundles[0].join(' '), bundles[1].join(' ')];
}

/** Clustered ink spatter around the sweep: fine mist and heavier dots (sizes
 * power-law distributed), plus a few wobbly splots at the cluster hearts. */
function buildInkSpatter(): [string, string] {
  const rand = mulberry32(0x50a7);
  // [cx, cy, rx, ry, count]
  const clusters: Array<[number, number, number, number, number]> = [
    [560, 58, 300, 60, 55],
    [940, 104, 100, 55, 28],
    [1250, 84, 170, 75, 45],
    [150, 244, 130, 55, 30],
    [390, 228, 120, 40, 18],
    [1420, 240, 80, 50, 16],
    [700, 26, 180, 26, 20],
    [1432, 148, 42, 85, 24],
  ];
  const mist: string[] = [];
  const dots: string[] = [];
  for (const [cx, cy, rx, ry, count] of clusters) {
    for (let i = 0; i < count; i++) {
      const s = 0.7 + rand() ** 3 * 5.5;
      // clamp inside the viewBox — overshoot clips dots to razor-flat edges
      const px = Math.min(cx + (rand() + rand() - 1) * rx, 1455 - s);
      const py = cy + (rand() + rand() - 1) * ry;
      const dot = `M${ri(px - s)},${ri(py)} a${r(s)},${r(s)} 0 1 0 ${r(s * 2)},0 a${r(s)},${r(s)} 0 1 0 ${r(-s * 2)},0 Z`;
      (s < 1.7 ? mist : dots).push(dot);
    }
  }
  for (let k = 0; k < clusters.length; k++) {
    const [cx, cy, rx, ry] = clusters[k];
    dots.push(
      splot(
        rand,
        Math.min(cx + (rand() - 0.5) * rx, 1444),
        cy + (rand() - 0.5) * ry,
        4 + rand() * 5,
      ),
    );
  }
  return [mist.join(' '), dots.join(' ')];
}

const [inkFilamentsA, inkFilamentsB] = buildInkFilaments();
const [inkMist, inkDots] = buildInkSpatter();

export interface InkStroke {
  key: string;
  d: string;
  opacity: number;
  fillRule?: 'evenodd';
}

// Only the body may use evenodd (its comb gaps are holes) — on the spatter
// paths it would erase overlapping dots into white lenses instead of merging.
export const INK_STROKES: InkStroke[] = [
  { key: 'body', d: buildInkBody(), opacity: 0.16, fillRule: 'evenodd' },
  { key: 'filaments-a', d: inkFilamentsA, opacity: 0.16 },
  { key: 'filaments-b', d: inkFilamentsB, opacity: 0.11 },
  { key: 'dots', d: inkDots, opacity: 0.42 },
  { key: 'mist', d: inkMist, opacity: 0.2 },
];

/** The royal blue the sweep is painted in. */
export const INK_COLOR = '#2b50c2';
