import { useEffect, useRef, useState } from 'react';

import { useIsDark } from '../hooks/useIsDark';

import styles from './LondonSkyline.module.css';

interface LondonSkylineProps {
  className?: string;
}

/** Rounds to 0.1 to keep generated path coordinates tidy in the DOM. */
const r = (n: number) => Math.round(n * 10) / 10;

// London Eye geometry — a wheel floating on an A-frame to the ground line.
const EYE_CX = 335;
const EYE_CY = 408;
const EYE_R = 112;
const EYE_SPOKES = 24;

/** Builds the Eye's spokes (hub → rim) for a given capsule count. */
function buildEye() {
  const spokes: string[] = [];
  const capsules: Array<{ cx: number; cy: number }> = [];
  for (let i = 0; i < EYE_SPOKES; i++) {
    const a = (i / EYE_SPOKES) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    spokes.push(
      `M${r(EYE_CX + 16 * cos)},${r(EYE_CY + 16 * sin)} L${r(EYE_CX + 104 * cos)},${r(EYE_CY + 104 * sin)}`,
    );
    capsules.push({ cx: r(EYE_CX + EYE_R * cos), cy: r(EYE_CY + EYE_R * sin) });
  }
  return { spokes, capsules };
}

// The Shard — straight tapering edges with horizontal floor bands.
const SHARD = {
  baseL: 1140,
  baseR: 1226,
  apexL: 1182,
  apexR: 1186,
  baseY: 600,
  apexY: 108,
};

/** Interpolates the Shard's left/right edge x at each floor line height. */
function buildShardFloors() {
  const floors: Array<{ x1: number; x2: number; y: number }> = [];
  for (let y = 562; y >= 150; y -= 30) {
    const t = (SHARD.baseY - y) / (SHARD.baseY - SHARD.apexY);
    floors.push({
      x1: r(SHARD.baseL + (SHARD.apexL - SHARD.baseL) * t),
      x2: r(SHARD.baseR + (SHARD.apexR - SHARD.baseR) * t),
      y,
    });
  }
  return floors;
}

// The Gherkin — a bullet silhouette filled with a clipped diamond lattice.
const GHERKIN_SILHOUETTE =
  'M1312,600 C1300,540 1300,500 1303,455 C1308,380 1322,300 1338,250 ' +
  'C1354,300 1368,380 1373,455 C1376,500 1376,540 1364,600 Z';

/** Generates the two diagonal line families forming the Gherkin's mesh. */
function buildGherkinLattice() {
  const x0 = 1290;
  const x1 = 1386;
  const lines: string[] = [];
  // Slope -1 (/): y = c - x.
  for (let c = 1520; c <= 1986; c += 22) {
    lines.push(`M${x0},${r(c - x0)} L${x1},${r(c - x1)}`);
  }
  // Slope +1 (\): y = x + c.
  for (let c = -1156; c <= -690; c += 22) {
    lines.push(`M${x0},${r(x0 + c)} L${x1},${r(x1 + c)}`);
  }
  return lines;
}

/** Samples a quadratic Bézier so suspension hangers drop from chain to deck. */
function buildHangers(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  deckY: number,
  ts: number[],
) {
  return ts.map((t) => {
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    return `M${r(x)},${r(y)} L${r(x)},${deckY}`;
  });
}

const { spokes: eyeSpokes, capsules: eyeCapsules } = buildEye();
const shardFloors = buildShardFloors();
const gherkinLattice = buildGherkinLattice();
const centralHangers = buildHangers(
  [758, 366],
  [860, 475],
  [962, 366],
  560,
  [0.22, 0.36, 0.5, 0.64, 0.78],
);
const leftSideHangers = buildHangers(
  [692, 366],
  [650, 500],
  [610, 560],
  560,
  [0.35, 0.6, 0.82],
);
const rightSideHangers = buildHangers(
  [1028, 366],
  [1070, 500],
  [1110, 560],
  560,
  [0.35, 0.6, 0.82],
);

// Sun (light mode) and crescent moon (dark mode) share this sky position.
const CELESTIAL = { cx: 1010, cy: 142 };
const SUN_R = 52;
const MOON_R = 54;

/** Builds the sun's 12 radiating tick marks around its disc. */
function buildSunRays() {
  const rays: string[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    rays.push(
      `M${r(CELESTIAL.cx + (SUN_R + 9) * cos)},${r(CELESTIAL.cy + (SUN_R + 9) * sin)} L${r(CELESTIAL.cx + (SUN_R + 24) * cos)},${r(CELESTIAL.cy + (SUN_R + 24) * sin)}`,
    );
  }
  return rays;
}

/** Crescent moon as the lune between two equal circles offset horizontally. */
function buildMoonPath() {
  const dx = 0.7 * MOON_R;
  const xi = CELESTIAL.cx + dx / 2;
  const yo = Math.sqrt(MOON_R * MOON_R - (dx / 2) * (dx / 2));
  const top = `${r(xi)},${r(CELESTIAL.cy - yo)}`;
  const bot = `${r(xi)},${r(CELESTIAL.cy + yo)}`;
  return `M${top} A${MOON_R},${MOON_R} 0 1 1 ${bot} A${MOON_R},${MOON_R} 0 0 0 ${top} Z`;
}

/** Four-pointed sparkle star centred at (x, y) with point reach s. */
function buildStar(x: number, y: number, s: number) {
  const i = s * 0.3;
  return `M${r(x)},${r(y - s)} L${r(x + i)},${r(y - i)} L${r(x + s)},${r(y)} L${r(x + i)},${r(y + i)} L${r(x)},${r(y + s)} L${r(x - i)},${r(y + i)} L${r(x - s)},${r(y)} L${r(x - i)},${r(y - i)} Z`;
}

const sunRays = buildSunRays();
const moonPath = buildMoonPath();
const stars = [
  [250, 175, 13],
  [430, 110, 16],
  [600, 205, 11],
  [690, 120, 14],
  [840, 178, 12],
  [880, 95, 15],
  [1260, 132, 14],
].map(([x, y, s]) => buildStar(x, y, s));

// Clouds drifting across the light-mode sky — a puffy 3-bump and a wide 4-bump
// outline, placed and scaled across the upper sky (stroke width undoes the scale
// so it matches the buildings). delay staggers their drift-in.
const CLOUD_PUFFY =
  'M14,40 a16,16 0 0 1 -2,-31 a18,18 0 0 1 34,-6 a20,20 0 0 1 38,5 a15,15 0 0 1 22,32 z';
const CLOUD_WIDE =
  'M10,44 a14,14 0 0 1 0,-22 a16,16 0 0 1 26,-10 a18,18 0 0 1 34,2 a16,16 0 0 1 30,6 a14,14 0 0 1 18,24 z';
const clouds = [
  { path: CLOUD_PUFFY, x: 235, y: 150, scale: 1.25, delay: 0.1 },
  { path: CLOUD_WIDE, x: 560, y: 92, scale: 1.25, delay: 0.35 },
  { path: CLOUD_PUFFY, x: 815, y: 180, scale: 0.95, delay: 0.6 },
];

// Sky wash (light mode) — one sumi-e brush sweep behind the sun, clouds and
// building tops: a wave cresting left, sagging through a deep belly mid-frame
// and surging up to the right edge. Everything below is generated
// deterministically (seeded PRNG, identical on server and client): ragged
// noisy edges with bristle nicks, dry-brush comb gaps cut along the flanks,
// filament bundles trailing off every edge, and clustered ink spatter.

/** Deterministic PRNG (mulberry32) so the generated ink matches across SSR and client. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The sweep's skeleton: [x, top edge y, bottom edge y] stations across the sky.
const INK_STATIONS: Array<[number, number, number]> = [
  [66, 148, 148],
  [120, 100, 166],
  [180, 70, 180],
  [240, 46, 188],
  [300, 34, 190],
  [360, 38, 196],
  [420, 52, 202],
  [480, 74, 208],
  [540, 96, 216],
  [600, 108, 232],
  [660, 110, 258],
  [720, 102, 280],
  [780, 106, 286],
  [840, 130, 288],
  [900, 158, 284],
  [940, 160, 282],
  [1000, 136, 280],
  [1060, 106, 276],
  [1120, 74, 268],
  [1180, 48, 252],
  [1240, 28, 240],
  [1300, 18, 228],
  [1360, 14, 214],
  [1420, 20, 196],
  [1450, 34, 180],
];

/** Catmull-Rom interpolation of a station edge (1 = top, 2 = bottom) at x. */
function edgeYAt(x: number, edge: 1 | 2): number {
  const s = INK_STATIONS;
  const cx = Math.min(s[s.length - 1][0], Math.max(s[0][0], x));
  let i = 0;
  while (i < s.length - 2 && s[i + 1][0] <= cx) i++;
  const t = (cx - s[i][0]) / (s[i + 1][0] - s[i][0]);
  const y0 = s[Math.max(0, i - 1)][edge];
  const y1 = s[i][edge];
  const y2 = s[i + 1][edge];
  const y3 = s[Math.min(s.length - 1, i + 2)][edge];
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * y1 +
      (-y0 + y2) * t +
      (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
      (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
  );
}

/** Local tangent angle of a sweep edge at x (radians, SVG y-down). */
function edgeAngleAt(x: number, edge: 1 | 2): number {
  return Math.atan2(edgeYAt(x + 20, edge) - edgeYAt(x - 20, edge), 40);
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
  return `M${r(x + nx * w)},${r(y + ny * w)} Q${r(cx + nx * w)},${r(cy + ny * w)} ${r(tx)},${r(ty)} Q${r(cx - nx * w)},${r(cy - ny * w)} ${r(x - nx * w)},${r(y - ny * w)} Z`;
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
    `${r((p[0] + q[0]) / 2)},${r((p[1] + q[1]) / 2)}`;
  let d = `M${mid(pts[5], pts[0])}`;
  for (let i = 0; i < 6; i++) {
    const p = pts[i];
    d += ` Q${r(p[0])},${r(p[1])} ${mid(p, pts[(i + 1) % 6])}`;
  }
  return `${d} Z`;
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
    pts.push(`${r(x)},${r(y)}`);
  }
  // right terminus: torn, not straight — jittered walk down with inward notches
  for (let y = 52; y <= 172; y += 11) {
    let x = 1451 + (rand() - 0.5) * 7;
    if (rand() < 0.3) x -= 10 + rand() * 16;
    pts.push(`${r(x)},${r(y + (rand() - 0.5) * 4)}`);
  }
  for (let x = 1450; x >= 66; x -= 12) {
    let y = edgeYAt(x, 2) + coarseBot(x) + fineBot(x);
    if (rand() < 0.16) y += 5 + rand() * 11;
    pts.push(`${r(x)},${r(y)}`);
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
      d += ` ${sliver(x, y, angle, len0 + rand() * (len1 - len0), 1.6 + rand() * 1.8, (rand() - 0.5) * 10)}`;
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
      const len = 14 + rand() * rand() * 80;
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
      const px = cx + (rand() + rand() - 1) * rx;
      const py = cy + (rand() + rand() - 1) * ry;
      const s = 0.7 + rand() ** 3 * 5.5;
      const dot = `M${r(px - s)},${r(py)} a${r(s)},${r(s)} 0 1 0 ${r(s * 2)},0 a${r(s)},${r(s)} 0 1 0 ${r(-s * 2)},0 Z`;
      (s < 1.7 ? mist : dots).push(dot);
    }
  }
  for (let k = 0; k < clusters.length; k++) {
    const [cx, cy, rx, ry] = clusters[k];
    dots.push(
      splot(
        rand,
        cx + (rand() - 0.5) * rx,
        cy + (rand() - 0.5) * ry,
        4 + rand() * 5,
      ),
    );
  }
  return [mist.join(' '), dots.join(' ')];
}

const [inkFilamentsA, inkFilamentsB] = buildInkFilaments();
const [inkMist, inkDots] = buildInkSpatter();
const INK_STROKES = [
  { d: buildInkBody(), opacity: 0.16 },
  { d: inkFilamentsA, opacity: 0.16 },
  { d: inkFilamentsB, opacity: 0.11 },
  { d: inkDots, opacity: 0.2 },
  { d: inkMist, opacity: 0.12 },
];

/**
 * Clean single-stroke line drawing of the London skyline — Big Ben, the London
 * Eye, St Paul's Cathedral, Tower Bridge, the Shard and the Gherkin — sitting on
 * a shared ground line, with a sun + blue ink-wash sky (light mode) / crescent
 * moon + stars (dark mode) behind them. Strokes resolve from `currentColor`
 * per element: light mode paints each landmark via the module's real-world
 * palette classes (coloured strokes + translucent fill washes), dark mode
 * reverts them all to one faint ink outline; used as the faint footer
 * watermark.
 */
export default function LondonSkyline({ className }: LondonSkylineProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [mounted, setMounted] = useState(false);
  const [inView, setInView] = useState(false);
  // Bumped on each light<->dark flip; keys the celestial groups so they remount
  // and re-run their fill animation (display:none -> shown alone won't restart it).
  // A counter (not `isDark` itself) keeps the SSR/first-paint key stable — keying
  // on isDark directly would hydration-mismatch.
  const isDark = useIsDark();
  const [themeFlips, setThemeFlips] = useState(0);
  const wasDark = useRef(isDark);

  // Re-play the sky-fill animation each time the skyline enters the viewport.
  useEffect(() => {
    setMounted(true);
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        // Arm at 35% visible; reset (so it re-arms) only once fully out of view.
        if (entry.intersectionRatio >= 0.35) setInView(true);
        else if (entry.intersectionRatio <= 0) setInView(false);
      },
      { threshold: [0, 0.35] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A light<->dark switch replays the sky-fill via the keyed remount below.
  useEffect(() => {
    if (wasDark.current !== isDark) {
      wasDark.current = isDark;
      setThemeFlips((n) => n + 1);
    }
  }, [isDark]);

  return (
    <svg
      ref={ref}
      className={[
        styles.skyline,
        className,
        mounted && styles.js,
        inView && styles.animate,
      ]
        .filter(Boolean)
        .join(' ')}
      viewBox="0 0 1460 600"
      preserveAspectRatio="xMidYMax meet"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="London skyline"
      data-london-skyline
      data-sun-x={CELESTIAL.cx}
      data-sun-y={CELESTIAL.cy}
    >
      {/* Sky ink — light mode only; always present (no entrance animation) */}
      <g className={styles.ink}>
        {INK_STROKES.map((s) => (
          <path key={s.d} d={s.d} fillRule="evenodd" fillOpacity={s.opacity} />
        ))}
      </g>

      {/* Sun — light mode only (disc fills in gradually + rays) */}
      <g key={`sun-${themeFlips}`} className={styles.sun}>
        <circle
          className={styles.sunDisc}
          cx={CELESTIAL.cx}
          cy={CELESTIAL.cy}
          r={SUN_R}
          fill="#ffffff"
        />
        {sunRays.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      {/* Crescent moon (gradual fill) + stars (blink in) — dark mode only */}
      <g key={`moon-${themeFlips}`} className={styles.moon}>
        <path className={styles.moonDisc} d={moonPath} fill="#ffffff" />
        {stars.map((d, i) => (
          <path
            key={d}
            className={styles.star}
            d={d}
            fill="#ffffff"
            style={{ animationDelay: `${0.15 + i * 0.12}s` }}
          />
        ))}
      </g>

      {/* Clouds — light mode only (drift in) */}
      <g key={`clouds-${themeFlips}`} className={styles.clouds}>
        {clouds.map((c) => (
          <g
            key={`${c.x},${c.y}`}
            transform={`translate(${c.x},${c.y}) scale(${c.scale})`}
          >
            <g
              className={styles.cloud}
              style={{ animationDelay: `${c.delay}s` }}
            >
              <path d={c.path} fill="#ffffff" strokeWidth={r(2 / c.scale)} />
            </g>
          </g>
        ))}
      </g>

      {/* Big Ben (Elizabeth Tower) */}
      <g className={styles.limestone}>
        <path
          className={styles.wash}
          d="M124,320 L176,320 L176,600 L124,600 Z"
        />
        <circle
          className={`${styles.gold} ${styles.tint}`}
          cx={150}
          cy={96}
          r={5}
        />
        <path className={styles.gold} d="M150,118 L150,101" />
        <path
          className={`${styles.roofSlate} ${styles.tint}`}
          d="M118,210 L150,118 L182,210"
        />
        <path className={styles.roofSlate} d="M118,210 L182,210" />
        <path className={styles.tint} d="M122,210 L122,255 L178,255 L178,210" />
        <path d="M134,215 L134,250 M146,215 L146,250 M158,215 L158,250 M170,215 L170,250" />
        <path className={styles.tint} d="M114,255 L114,265 L186,265 L186,255" />
        <path className={styles.tint} d="M120,265 L120,320 L180,320 L180,265" />
        <circle
          className={`${styles.clockBlue} ${styles.dialFace}`}
          cx={150}
          cy={292}
          r={19}
        />
        <path
          className={styles.clockBlue}
          d="M150,292 L150,279 M150,292 L161,292"
        />
        <path d="M124,320 L124,600 M176,320 L176,600" />
        <path d="M138,330 L138,600 M150,330 L150,600 M162,330 L162,600" />
        <path d="M124,420 L176,420 M124,510 L176,510" />
      </g>

      {/* London Eye */}
      <g className={styles.steel}>
        <path d="M305,600 L335,408 M368,600 L335,408" />
        <path d="M316,600 L356,600" />
        <circle cx={EYE_CX} cy={EYE_CY} r={118} />
        <circle cx={EYE_CX} cy={EYE_CY} r={104} />
        <circle cx={EYE_CX} cy={EYE_CY} r={16} />
        <circle cx={EYE_CX} cy={EYE_CY} r={5} />
        {eyeSpokes.map((d) => (
          <path key={d} d={d} />
        ))}
        {eyeCapsules.map((c) => (
          <circle
            key={`${c.cx},${c.cy}`}
            className={`${styles.capsuleGlass} ${styles.tint}`}
            cx={c.cx}
            cy={c.cy}
            r={6}
          />
        ))}
      </g>

      {/* St Paul's Cathedral */}
      <g className={styles.portland}>
        <path
          className={styles.wash}
          d="M478,470 L642,470 L642,595 L478,595 Z"
        />
        <path className={styles.gold} d="M560,279 L560,305 M553,293 L567,293" />
        <path
          className={`${styles.lead} ${styles.tint}`}
          d="M550,305 Q560,296 570,305"
        />
        <path className={styles.tint} d="M550,330 L550,305 L570,305 L570,330" />
        <path
          className={`${styles.lead} ${styles.tint}`}
          d="M525,395 Q525,335 560,330 Q595,335 595,395"
        />
        <path className={styles.tint} d="M525,440 L525,395 L595,395 L595,440" />
        <path d="M537,400 L537,438 M549,400 L549,438 M561,400 L561,438 M573,400 L573,438 M585,400 L585,438" />
        <path className={styles.tint} d="M488,470 L560,440 L632,470" />
        <path d="M478,470 L478,600 M642,470 L642,600" />
        <path d="M505,470 L505,595 M527,470 L527,595 M549,470 L549,595 M571,470 L571,595 M593,470 L593,595 M615,470 L615,595" />
        <path d="M478,595 L642,595" />
        <path
          className={styles.tint}
          d="M482,470 L482,430 L500,430 L500,470 M482,430 L491,418 L500,430"
        />
        <path
          className={styles.tint}
          d="M620,470 L620,430 L638,430 L638,470 M620,430 L629,418 L638,430"
        />
      </g>

      {/* Tower Bridge */}
      <g className={styles.bridgeBlue}>
        {/* deck and outer approaches */}
        <path d="M610,560 L1110,560" />
        <path
          className={styles.portland}
          d="M610,560 L610,600 M1110,560 L1110,600"
        />
        <path
          className={styles.portland}
          d="M686,560 L686,600 M764,560 L764,600 M956,560 L956,600 M1034,560 L1034,600"
        />
        <path d="M768,560 Q860,600 952,560" />

        {/* left tower */}
        <g className={styles.portland}>
          <path
            className={styles.tint}
            d="M692,560 L692,335 L758,335 L758,560"
          />
          <path d="M692,380 L758,380 M692,420 L758,420 M692,460 L758,460 M692,500 L758,500 M692,540 L758,540" />
          <path d="M708,345 L708,555 M725,345 L725,555 M742,345 L742,555" />
          <path d="M684,335 L766,335" />
          <path
            className={styles.tint}
            d="M709,335 L709,302 L741,302 L741,335"
          />
          <path className={styles.tint} d="M703,302 L725,255 L747,302" />
          <path d="M725,255 L725,243" />
          <path
            className={styles.tint}
            d="M686,335 L686,318 L696,318 L696,335 M686,318 L691,306 L696,318"
          />
          <path
            className={styles.tint}
            d="M754,335 L754,318 L764,318 L764,335 M754,318 L759,306 L764,318"
          />
        </g>

        {/* right tower */}
        <g className={styles.portland}>
          <path
            className={styles.tint}
            d="M962,560 L962,335 L1028,335 L1028,560"
          />
          <path d="M962,380 L1028,380 M962,420 L1028,420 M962,460 L1028,460 M962,500 L1028,500 M962,540 L1028,540" />
          <path d="M978,345 L978,555 M995,345 L995,555 M1012,345 L1012,555" />
          <path d="M954,335 L1036,335" />
          <path
            className={styles.tint}
            d="M979,335 L979,302 L1011,302 L1011,335"
          />
          <path className={styles.tint} d="M973,302 L995,255 L1017,302" />
          <path d="M995,255 L995,243" />
          <path
            className={styles.tint}
            d="M956,335 L956,318 L966,318 L966,335 M956,318 L961,306 L966,318"
          />
          <path
            className={styles.tint}
            d="M1024,335 L1024,318 L1034,318 L1034,335 M1024,318 L1029,306 L1034,318"
          />
        </g>

        {/* high-level walkways */}
        <path
          className={styles.wash}
          d="M758,338 L962,338 L962,366 L758,366 Z"
        />
        <path d="M758,338 L962,338 M758,366 L962,366" />
        <path d="M758,338 L758,366 M962,338 L962,366" />
        <path d="M772,338 L772,366 M788,338 L788,366 M804,338 L804,366 M820,338 L820,366 M836,338 L836,366 M884,338 L884,366 M900,338 L900,366 M916,338 L916,366 M932,338 L932,366 M948,338 L948,366" />
        <path d="M845,338 L860,322 L875,338" />

        {/* suspension chains + hangers */}
        <path d="M758,366 Q860,475 962,366" />
        <path d="M692,366 Q650,500 610,560" />
        <path d="M1028,366 Q1070,500 1110,560" />
        {[...centralHangers, ...leftSideHangers, ...rightSideHangers].map(
          (d) => (
            <path key={d} d={d} />
          ),
        )}
      </g>

      {/* The Shard */}
      <g className={styles.shardGlass}>
        <path
          className={styles.wash}
          d="M1140,600 L1181,112 L1187,112 L1226,600 Z"
        />
        <path d="M1140,600 L1181,112 M1226,600 L1187,112" />
        <path d="M1183,560 L1184,118" />
        <path d="M1181,112 L1178,88 M1184,112 L1184,82 M1187,112 L1191,92" />
        {shardFloors.map((f) => (
          <path key={f.y} d={`M${f.x1},${f.y} L${f.x2},${f.y}`} />
        ))}
      </g>

      {/* The Gherkin (30 St Mary Axe) */}
      <g className={styles.gherkinGlass}>
        <circle cx={1338} cy={232} r={4} />
        <path d="M1338,250 L1338,236" />
        <path className={styles.tint} d={GHERKIN_SILHOUETTE} />
        <clipPath id="gherkinClip">
          <path d={GHERKIN_SILHOUETTE} />
        </clipPath>
        <g clipPath="url(#gherkinClip)">
          {gherkinLattice.map((d) => (
            <path key={d} d={d} strokeWidth={1.4} />
          ))}
          <path d="M1290,360 L1386,360 M1290,440 L1386,440 M1290,520 L1386,520" />
        </g>
      </g>
    </svg>
  );
}
