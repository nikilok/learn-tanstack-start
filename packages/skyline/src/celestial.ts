/**
 * What hangs in the skyline's sky: the sun (light) or the crescent moon and sparkle stars
 * (dark), plus the clouds drifting under them.
 */
import { r } from './units.ts';

/** Sun (light mode) and crescent moon (dark mode) share this sky position. */
export const CELESTIAL = { cx: 1010, cy: 142 };
export const SUN_R = 52;
export const MOON_R = 54;

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
export function buildStar(x: number, y: number, s: number) {
  const i = s * 0.3;
  return `M${r(x)},${r(y - s)} L${r(x + i)},${r(y - i)} L${r(x + s)},${r(y)} L${r(x + i)},${r(y + i)} L${r(x)},${r(y + s)} L${r(x - i)},${r(y + i)} L${r(x - s)},${r(y)} L${r(x - i)},${r(y - i)} Z`;
}

export const SUN_RAYS = buildSunRays();
export const MOON_PATH = buildMoonPath();
export const STARS = [
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
export const CLOUD_PUFFY =
  'M14,40 a16,16 0 0 1 -2,-31 a18,18 0 0 1 34,-6 a20,20 0 0 1 38,5 a15,15 0 0 1 22,32 z';
export const CLOUD_WIDE =
  'M10,44 a14,14 0 0 1 0,-22 a16,16 0 0 1 26,-10 a18,18 0 0 1 34,2 a16,16 0 0 1 30,6 a14,14 0 0 1 18,24 z';

export interface CloudPlacement {
  path: string;
  x: number;
  y: number;
  scale: number;
  delay: number;
}

export const CLOUDS: CloudPlacement[] = [
  { path: CLOUD_PUFFY, x: 235, y: 150, scale: 1.25, delay: 0.1 },
  { path: CLOUD_WIDE, x: 560, y: 92, scale: 1.25, delay: 0.35 },
  { path: CLOUD_PUFFY, x: 815, y: 180, scale: 0.95, delay: 0.6 },
];
