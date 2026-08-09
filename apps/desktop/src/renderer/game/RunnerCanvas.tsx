import { buildStar, CELESTIAL, MOON_PATH, SUN_R, SUN_RAYS } from '@ss/skyline';
import { useCallback, useEffect, useRef, useState } from 'react';

import { skyAt } from './daylight';
import {
  DEMO_AFTER_MS,
  DEMO_FADE_MS,
  demoShouldJump,
  demoStintOver,
  demoStintTarget,
} from './demo';
import { InkSky } from './InkSky';
import { drawLandmark, landmarkPaint } from './landmark-draw';
import type { LandmarkPaint } from './landmark-draw';
import {
  createRunner,
  jump,
  PLAYER_R,
  PLAYER_X,
  runnerScore,
  stepRunner,
} from './runner';
import type { Obstacle, RunnerState } from './runner';
import { CLOUD_PUFFY, CLOUD_WIDE, makeClouds, makeStars } from './sky';
import type { Cloud, Star } from './sky';
import { closeSound, playCrash, playJump } from './sound';
import { sweatDrops } from './sweat';

/**
 * The canvas fills the screen, so the ground can run to the window's edges the way the
 * site footer's does — a horizon with the surface simply continuing below it, rather than
 * a band with a hard edge partway down. The status line then sits ON that surface, exactly
 * as the footer's own content sits under its skyline.
 *
 * These three are geometry rather than constants because of it, recomputed on resize.
 * There is one canvas on the screen, so module scope is where they belong.
 */
let HEIGHT = 210;
let GROUND_Y = 156;
let SKY_BAND = 130; // how far down the sky's scenery may reach
/** How much surface sits below the horizon. The rest of the canvas is sky. */
const ROAD_DEPTH = 190;
const BEST_KEY = 'ss-runner-best';

/** Reads the saved best. Storage can be unavailable on a file:// document, and a high score is never worth a blank screen. */
function readBest(): number {
  try {
    return Number(window.localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Persists a new best, silently doing nothing when storage is unavailable. */
function writeBest(score: number): void {
  try {
    window.localStorage.setItem(BEST_KEY, String(score));
  } catch {
    /* not worth surfacing */
  }
}

interface Palette {
  // The ground, borrowed from the site footer the city stands on: a hairline over a
  // translucent surface (--footer-line / --footer-bg). The footer draws no road markings
  // and neither does this — the landmarks going past are what carry the speed.
  groundLine: string;
  groundFill: string;
  dim: string; // the high score and the prompt, neither of which is the point
  score: string; // the run you are on, which is
  sky: string; // the stars
  cloud: string; // the cloud body
  cloudLine: string; // and its outline, which is what makes it read as drawn
  orb: string; // the moon, or the sun
  orbGlow: string | null; // null by day, where a halo over the ink only goes muddy
  /** The mascot's own ink: its legs, its arm and its hand. Near-white at night, the
   *  logo's navy by day — named for the part rather than the colour, since it is both. */
  limb: string;
  red: string;
  sweat: string; // the beads flicking off it once a run has been going a while
}

function palette(dark: boolean): Palette {
  return dark
    ? {
        groundLine: '#3a3a3a', // --footer-line
        groundFill: 'rgba(10,10,10,0.5)', // --footer-bg
        dim: 'rgba(231,233,238,0.3)',
        score: 'rgba(231,233,238,0.72)',
        sky: 'rgba(255,255,255,0.9)',
        cloud: 'rgba(226,232,255,0.10)', // dark mode draws no clouds
        cloudLine: 'rgba(226,232,255,0.16)',
        orb: 'rgba(233,236,255,0.85)',
        orbGlow: 'rgba(180,200,255,0.10)',
        limb: '#e0e7ff',
        red: '#f87171',
        sweat: 'rgba(196,222,255,0.95)',
      }
    : {
        groundLine: '#d6d6d6', // --footer-line
        groundFill: 'rgba(255,255,255,0.5)', // --footer-bg
        // Darker than the dark theme's equivalents: in light mode the score sits over the
        // ink sweep, and at the weight the night sky wants it disappears into the wash.
        dim: 'rgba(31,36,48,0.5)',
        score: 'rgba(31,36,48,0.88)',
        sky: 'rgba(255,255,255,0.95)',
        // White with an inked outline, exactly as the footer skyline draws them: on a
        // near-white sky it is the line that makes the cloud, not the fill. The weight is
        // the footer's own faint ink, not a hard black line.
        cloud: '#ffffff',
        cloudLine: 'rgba(122,122,122,0.9)',
        // Opaque, unlike the moon: the ink sweep passes behind it, and a translucent sun
        // would show the brushwork straight through its face.
        orb: '#ffd98f',
        // No halo by day. Warm light over the blue wash goes muddy, and the footer's sun
        // is a flat disc with rays — the rays are what make it read as shining.
        orbGlow: null,
        limb: '#001c55',
        red: '#c8102e',
        sweat: 'rgba(86,146,208,0.9)',
      };
}

// Built once from the site's own outlines; Path2D takes SVG path data as-is.
const CLOUD_PUFFY_PATH = new Path2D(CLOUD_PUFFY);
const CLOUD_WIDE_PATH = new Path2D(CLOUD_WIDE);
// The skyline's four-pointed sparkle at unit size, scaled per star rather than rebuilt.
const SPARKLE_PATH = new Path2D(buildStar(0, 0, 1));
// The sun's rays and the crescent moon, in the skyline's own coordinates. Both are drawn
// about CELESTIAL, so the canvas moves that point to wherever the orb sits.
const SUN_RAY_PATH = new Path2D(SUN_RAYS.join(' '));
const MOON_DISC_PATH = new Path2D(MOON_PATH);

const HIP_Y = PLAYER_R * 0.6; // hips, below the lens's centre
const LEG_LEN = PLAYER_R * 0.87;
const STRIDE = 1; // radians either side of straight down, at the top of the swing
/** Everything drawn on the lens is a fraction of its radius, so it scales as one piece. */
const LINE = PLAYER_R * 0.22;
// Centre of the lens to the ground when standing. The physics tracks the feet, so the
// body is drawn this far above them and the whole character clears an obstacle together.
const FOOT_DROP = HIP_Y + LEG_LEN;

// The flag inside the lens, scaled off the clip radius from the real mark's proportions
// (Logo.tsx draws these against a clip of 29 in its own 130-unit viewBox).
const FLAG_R = PLAYER_R * 0.72;
const SALTIRE_W = FLAG_R * 0.41;
const SALTIRE_RED = FLAG_R * 0.14;
const CROSS_W = FLAG_R * 0.69;
const CROSS_RED = FLAG_R * 0.41;

/** One leg from its hip, swung to `angle` (0 = straight down), with a shoe on the end. */
function drawLeg(
  c: CanvasRenderingContext2D,
  p: Palette,
  hipX: number,
  angle: number,
): void {
  const hipY = HIP_Y;
  const footX = hipX + Math.sin(angle) * LEG_LEN;
  const footY = hipY + Math.cos(angle) * LEG_LEN;
  c.lineWidth = LINE;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  c.strokeStyle = p.limb;
  c.beginPath();
  c.moveTo(hipX, hipY);
  c.lineTo(footX, footY);
  c.stroke();

  // The shoe, in the brand red, pointing the way it is going. Drawn as its own stroke
  // starting at the ankle rather than as a second segment of the leg's path: the round cap
  // then lands over the leg's own, so the two read as one joint instead of a seam.
  c.strokeStyle = p.red;
  c.beginPath();
  c.moveTo(footX, footY);
  c.lineTo(footX + PLAYER_R * 0.3, footY);
  c.stroke();
}

/**
 * The Union Jack in the lens, at the real mark's proportions: a saltire under a cross,
 * each in white with a narrower red over it. The earlier version had the cross only, which
 * is why it read as a plus sign rather than a flag.
 */
function drawFlag(c: CanvasRenderingContext2D, p: Palette): void {
  c.save();
  c.beginPath();
  c.arc(0, 0, FLAG_R, 0, Math.PI * 2);
  c.clip();
  c.fillStyle = '#012169';
  c.fillRect(-FLAG_R, -FLAG_R, FLAG_R * 2, FLAG_R * 2);

  const d = FLAG_R * 1.5; // past the corners, so the diagonals reach the clip's edge
  c.lineCap = 'butt';
  for (const [width, colour] of [
    [SALTIRE_W, '#ffffff'],
    [SALTIRE_RED, p.red],
  ] as const) {
    c.strokeStyle = colour;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(-d, -d);
    c.lineTo(d, d);
    c.moveTo(d, -d);
    c.lineTo(-d, d);
    c.stroke();
  }
  for (const [width, colour] of [
    [CROSS_W, '#ffffff'],
    [CROSS_RED, p.red],
  ] as const) {
    c.strokeStyle = colour;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(0, -d);
    c.lineTo(0, d);
    c.moveTo(-d, 0);
    c.lineTo(d, 0);
    c.stroke();
  }
  c.restore();
}

/** Eyes over the glass: open and looking ahead, wide in the air, crossed out on a crash. */
function drawEyes(
  c: CanvasRenderingContext2D,
  over: boolean,
  airborne: boolean,
  blinking: boolean,
): void {
  // Above the flag's red bar, not across it: sitting on the bar, white eyes on red read as
  // part of the pattern rather than as a face.
  const y = -PLAYER_R * 0.34;
  const r = PLAYER_R * (airborne ? 0.227 : 0.2);
  const cross = PLAYER_R * 0.147;
  for (const x of [-PLAYER_R * 0.3, PLAYER_R * 0.34]) {
    if (over) {
      c.strokeStyle = '#12203f';
      c.lineWidth = LINE * 0.47;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - cross, y - cross);
      c.lineTo(x + cross, y + cross);
      c.moveTo(x + cross, y - cross);
      c.lineTo(x - cross, y + cross);
      c.stroke();
      continue;
    }
    if (blinking) {
      c.strokeStyle = '#12203f';
      c.lineWidth = LINE * 0.47;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - r * 0.8, y);
      c.lineTo(x + r * 0.8, y);
      c.stroke();
      continue;
    }
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    // A hairline rim, so a white eye still has an edge where it lands on the flag's white.
    c.strokeStyle = 'rgba(18,32,63,0.45)';
    c.lineWidth = LINE * 0.2;
    c.stroke();
    c.fillStyle = '#12203f';
    c.beginPath();
    // Pupils sit forward, so it reads as looking where it is going.
    c.arc(
      x + r * 0.34,
      y + (airborne ? -r * 0.2 : 0),
      r * 0.46,
      0,
      Math.PI * 2,
    );
    c.fill();
  }
}

const MOUTH_Y = PLAYER_R * 0.3;
const MOUTH_INK = '#12203f';

/**
 * A mouth under the flag's red bar, and the only part of the face that answers to what is
 * happening: a small closed smile waiting to start, a wide open grin once it is running,
 * a round one for the effort of a jump, and corners down after it hits something.
 *
 * Everything here carries a white halo under the ink, for the same reason the eyes carry a
 * rim — the flag underneath is navy in some places and white in others, and a mark this
 * small disappears into one of them wherever it happens to land.
 */
function drawMouth(c: CanvasRenderingContext2D, pose: Pose): void {
  c.lineCap = 'round';
  c.lineJoin = 'round';

  if (!pose.over && pose.airborne) {
    // Round and open, for the effort of the jump.
    const r = PLAYER_R * 0.12;
    c.beginPath();
    c.ellipse(0, MOUTH_Y, r * 1.1, r, 0, 0, Math.PI * 2);
    c.fillStyle = '#ffffff';
    c.fill();
    c.strokeStyle = MOUTH_INK;
    c.lineWidth = LINE * 0.32;
    c.stroke();
    return;
  }

  if (!pose.over && pose.running) {
    // Game on: an open grin, filled rather than drawn as a line. A stroked smile reads as
    // polite at this size; the flat top and the weight of the fill are what make it read
    // as a character enjoying itself.
    const half = PLAYER_R * 0.23;
    c.beginPath();
    c.moveTo(-half, MOUTH_Y);
    c.quadraticCurveTo(0, MOUTH_Y + PLAYER_R * 0.3, half, MOUTH_Y);
    c.closePath();
    c.strokeStyle = '#ffffff';
    c.lineWidth = LINE * 0.5;
    c.stroke();
    c.fillStyle = MOUTH_INK;
    c.fill();
    return;
  }

  // Positive bulges the middle downward — a smile. Negative lifts it, dropping the corners.
  const half = PLAYER_R * 0.17;
  const curve = pose.over ? -PLAYER_R * 0.15 : PLAYER_R * 0.2;
  for (const [width, colour] of [
    [LINE * 0.78, '#ffffff'],
    [LINE * 0.34, MOUTH_INK],
  ] as const) {
    c.strokeStyle = colour;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(-half, MOUTH_Y);
    c.quadraticCurveTo(0, MOUTH_Y + curve, half, MOUTH_Y);
    c.stroke();
  }
}

/**
 * Beads flicking off the brow. Drawn in the lens's own space, so `sweatDrops` hands back
 * offsets from its centre and this only has to fade and shrink them along the way.
 */
function drawSweat(
  c: CanvasRenderingContext2D,
  p: Palette,
  dist: number,
  score: number,
): void {
  c.fillStyle = p.sweat;
  for (const d of sweatDrops(dist, score, PLAYER_R)) {
    // Full for the first stretch of the flight, then out — a bead that fades from the
    // instant it leaves never reads as having been thrown.
    c.globalAlpha = Math.min(1, (1 - d.life) * 2.2);
    c.beginPath();
    c.arc(d.x, d.y, PLAYER_R * 0.1 * (1 - d.life * 0.5), 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
}

interface Pose {
  /** Run cycle, in radians. */
  phase: number;
  airborne: boolean;
  running: boolean;
  over: boolean;
  blinking: boolean;
  /** Ground travelled and points scored, which is all the sweat is driven by. */
  dist: number;
  score: number;
}

/**
 * The search lens as a runner: the logo's mark for a head, legs that alternate under it,
 * and the magnifier's own handle doing the work of an arm, with a hand on the end. Drawn
 * back to front, so every joint disappears under the body.
 */
function drawLens(
  c: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  p: Palette,
  pose: Pose,
): void {
  const swing = pose.running && !pose.airborne ? Math.sin(pose.phase) : 0;
  // A stride's worth of bob, at twice the leg rate: two steps per cycle, one dip each.
  const bob =
    pose.airborne || !pose.running
      ? 0
      : Math.abs(Math.cos(pose.phase)) * PLAYER_R * 0.1;

  c.save();
  c.translate(cx, cy - bob);
  c.rotate(pose.over ? Math.PI / 7 : 0);

  // Legs. Airborne is a fixed tuck rather than a frozen frame of the run, and standing
  // still is a slight stance rather than two parallel sticks.
  const stance = pose.running ? 0 : 0.16;
  drawLeg(c, p, -3, pose.airborne ? 0.7 : swing * STRIDE + stance);
  drawLeg(c, p, 5, pose.airborne ? -0.85 : -swing * STRIDE - stance);

  // The handle, swinging against the legs the way an arm does, ending in a hand. It sits
  // shallower than the logo's 45 degrees so it reads at shoulder height, not knee height.
  const arm = 0.58 + (pose.airborne ? -0.6 : -swing * 0.45);
  const reach = PLAYER_R * 1.34;
  const handX = Math.cos(arm) * reach;
  const handY = Math.sin(arm) * reach;
  c.strokeStyle = p.limb;
  c.lineWidth = LINE * 1.18;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(Math.cos(arm) * PLAYER_R * 0.7, Math.sin(arm) * PLAYER_R * 0.7);
  c.lineTo(handX, handY);
  c.stroke();
  c.fillStyle = p.limb;
  c.beginPath();
  c.arc(handX, handY, PLAYER_R * 0.227, 0, Math.PI * 2);
  c.fill();

  c.beginPath();
  c.arc(0, 0, PLAYER_R, 0, Math.PI * 2);
  c.fill();

  drawFlag(c, p);
  drawEyes(c, pose.over, pose.airborne, pose.blinking);
  drawMouth(c, pose);
  // Last, so the beads sit over the head rather than under its rim. Gone the moment it
  // stops running: a crashed lens lying on its side is not still working.
  if (pose.running) drawSweat(c, p, pose.dist, pose.score);
  c.restore();
}

// A London bus is red whatever the app's theme is, so its colours are its own rather than
// the palette's. Front faces left, into the direction the runner is coming from.
const BUS_BODY = '#cc1f2d';
const BUS_SHADE = '#9e141f';
const BUS_BAND = '#f3ece1';
const BUS_GLASS = '#cfe0f5';
const BUS_TYRE = '#15161c';

/**
 * The double-decker: two rows of glass, a cream band between the decks, and wheels on the
 * road. Every measurement is a multiple of `u`, the bus's own height over the 25 units it
 * was drawn at, so it holds together at whatever size the run asks for.
 */
function drawBus(c: CanvasRenderingContext2D, o: Obstacle): void {
  const u = o.h / 25;
  const top = GROUND_Y - o.h;
  const wheelR = 3.2 * u;
  const bodyH = o.h - wheelR; // the body rides above the axles

  c.fillStyle = BUS_BODY;
  c.beginPath();
  c.roundRect(o.x, top, o.w, bodyH, 3 * u);
  c.fill();

  // Cream band on the deck line, which is what makes it read as a double-decker rather
  // than a red box.
  const deck = top + bodyH * 0.5;
  c.fillStyle = BUS_BAND;
  c.fillRect(o.x, deck - 1.2 * u, o.w, 2.4 * u);

  // Upper deck: a run of windows, with the front one wrapped round the nose.
  c.fillStyle = BUS_GLASS;
  const upperY = top + 3.5 * u;
  const upperH = bodyH * 0.5 - 6 * u;
  c.fillRect(o.x + 2.5 * u, upperY, 7 * u, upperH); // windscreen
  for (let x = o.x + 12 * u; x < o.x + o.w - 4 * u; x += 8 * u) {
    c.fillRect(x, upperY, 5.5 * u, upperH);
  }

  // Lower deck: windscreen, then windows, then the open platform at the back.
  const lowerY = deck + 2.4 * u;
  const lowerH = bodyH * 0.5 - 6 * u;
  c.fillRect(o.x + 2.5 * u, lowerY, 8 * u, lowerH);
  for (let x = o.x + 13 * u; x < o.x + o.w - 8 * u; x += 8 * u) {
    c.fillRect(x, lowerY, 5.5 * u, lowerH);
  }
  c.fillStyle = BUS_SHADE;
  c.fillRect(o.x + o.w - 6.5 * u, lowerY, 4.5 * u, lowerH); // rear platform, in shadow

  // Destination blind over the windscreen, and a headlight below it.
  c.fillStyle = BUS_BAND;
  c.fillRect(o.x + 2.5 * u, top + 1.2 * u, 9 * u, 2 * u);
  c.fillStyle = '#ffe9b0';
  c.beginPath();
  c.arc(o.x + 3 * u, GROUND_Y - wheelR - 2.5 * u, 1.3 * u, 0, Math.PI * 2);
  c.fill();

  // Resting on the road rather than sunk through it: the ground line is drawn at
  // GROUND_Y + 1, so the tyres have to bottom out just above it.
  c.fillStyle = BUS_TYRE;
  for (const wx of [o.x + o.w * 0.22, o.x + o.w * 0.78]) {
    c.beginPath();
    c.arc(wx, GROUND_Y - wheelR - 0.8 * u, wheelR, 0, Math.PI * 2);
    c.fill();
  }
}

/** The night sky: a crescent moon and a twinkling star field, drifting far slower than the ground. */
function drawStars(
  c: CanvasRenderingContext2D,
  p: Palette,
  stars: Star[],
  width: number,
  dist: number,
  now: number,
): void {
  const drift = dist * 0.05;
  c.fillStyle = p.sky;
  for (const s of stars) {
    const x = (((s.x * width - drift) % width) + width) % width;
    const y = 8 + s.y * SKY_BAND;
    // Each star breathes on its own clock; the amplitude is small enough to read as air.
    const twinkle = 0.55 + 0.45 * Math.sin(now / 900 + s.phase);
    c.globalAlpha = twinkle * (s.bright ? 1 : 0.7);
    if (s.bright) {
      // The footer's four-pointed sparkle, which is what separates the bright few from
      // the dots. Same shape the skyline blinks into its own night sky.
      c.save();
      c.translate(x, y);
      c.scale(s.r * 3.4, s.r * 3.4);
      c.fill(SPARKLE_PATH);
      c.restore();
      continue;
    }
    c.beginPath();
    c.arc(x, y, s.r, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
}

/** The daytime sky: a soft sun and clouds, drifting far slower than the ground. */
function drawClouds(
  c: CanvasRenderingContext2D,
  p: Palette,
  clouds: Cloud[],
  width: number,
  dist: number,
): void {
  const drift = dist * 0.08;
  c.fillStyle = p.cloud;
  c.strokeStyle = p.cloudLine;
  c.lineJoin = 'round';
  for (const cloud of clouds) {
    const x = (((cloud.x * width - drift) % width) + width) % width;
    const y = 14 + cloud.y * (SKY_BAND * 0.6);
    c.save();
    c.translate(x, y);
    c.scale(cloud.scale, cloud.scale);
    // Undo the scale on the stroke, the way the skyline does, so every cloud is outlined
    // at the same weight however big it is.
    c.lineWidth = 2 / cloud.scale;
    const path = cloud.wide ? CLOUD_WIDE_PATH : CLOUD_PUFFY_PATH;
    c.fill(path);
    c.stroke(path);
    c.restore();
  }
}

/**
 * The moon or the sun, whichever the theme calls for, parked in the upper right — the
 * footer's own rayed sun and crescent moon, which are drawn about CELESTIAL in skyline
 * units and so get moved and scaled into place here.
 */
function drawOrb(
  c: CanvasRenderingContext2D,
  p: Palette,
  width: number,
  dark: boolean,
): void {
  const cx = width - 150;
  // Sat low enough that its glow clears the score along the top edge, which it used to
  // wash straight through.
  const cy = 96;
  const r = 26;
  if (p.orbGlow) {
    // A gradient, not a flat disc: a translucent circle at a fixed alpha has a hard edge
    // and reads as a grey plate behind the moon rather than as light coming off it.
    const glow = c.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 3.2);
    glow.addColorStop(0, p.orbGlow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = glow;
    c.beginPath();
    c.arc(cx, cy, r * 3.2, 0, Math.PI * 2);
    c.fill();
  }

  const s = r / SUN_R;
  c.save();
  c.translate(cx, cy);
  c.scale(s, s);
  c.translate(-CELESTIAL.cx, -CELESTIAL.cy);
  c.fillStyle = p.orb;
  if (dark) {
    c.fill(MOON_DISC_PATH);
  } else {
    c.beginPath();
    c.arc(CELESTIAL.cx, CELESTIAL.cy, SUN_R, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = p.orb;
    c.lineWidth = 2 / s; // the skyline's own stroke weight, held at screen size
    c.lineCap = 'round';
    c.stroke(SUN_RAY_PATH);
  }
  c.restore();
}

export interface RunnerCanvasProps {
  /** False while the screen is hidden, so nothing animates behind a closed overlay. */
  active: boolean;
  /** The theme the screen opened in. A run turns the sky over from here as it goes. */
  dark: boolean;
  /** The sky the run has reached, so the rest of the screen can follow it. */
  onSky?: (dark: boolean) => void;
}

/** The endless runner itself: input, the frame loop, and drawing. All of the rules live in runner.ts. */
export function RunnerCanvas({ active, dark, onSky }: RunnerCanvasProps) {
  // The sky the run is in, which is not always the one the app is in — it turns over at
  // milestones. State rather than a ref, because the ink layer is a React child of it.
  const [night, setNight] = useState(dark);
  // Read through a ref so the frame loop never re-subscribes on a new callback identity.
  const onSkyRef = useRef(onSky);
  onSkyRef.current = onSky;
  useEffect(() => setNight(dark), [dark]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<RunnerState>(createRunner(600));
  const fastFallRef = useRef(false);
  const bestRef = useRef(readBest());
  // The lens plays itself after a stretch of quiet, and hands straight back on any press.
  const demoRef = useRef(false);
  const lastInputRef = useRef(0);
  const demoRestartRef = useRef(0);
  // Each stint bows out at its own score, so the changeovers do not read as a metronome.
  const demoTargetRef = useRef(demoStintTarget(Math.random));
  // The changeover between demo runs: 'out' while the last one dissolves, 'in' while the
  // next one arrives. A player's run never fades.
  const fadeRef = useRef<{ phase: 'none' | 'out' | 'in'; at: number }>({
    phase: 'none',
    at: 0,
  });
  // Generated once and kept in normalised space, so a resize re-uses the same sky.
  const skyRef = useRef({
    stars: makeStars(48, Math.random),
    clouds: makeClouds(5, Math.random),
  });

  // A press starts the run, jumps, or begins a new one once the last has ended. Restarting
  // launches straight into the next run rather than parking on an idle screen that needs a
  // second press. The whole game lives in a ref: nothing here needs a re-render, and the
  // frame loop owns the draw.
  const press = useCallback(() => {
    lastInputRef.current = performance.now();
    const s = stateRef.current;
    // Taking over from the demo starts a clean run rather than inheriting whatever the
    // demo had got itself into — nobody wants to be handed a lens mid-air in front of
    // Tower Bridge, or a score they did not earn.
    if (demoRef.current) {
      demoRef.current = false;
      demoRestartRef.current = 0;
      fadeRef.current = { phase: 'none', at: 0 };
      demoTargetRef.current = demoStintTarget(Math.random);
      stateRef.current = jump(createRunner(s.width));
      playJump();
      return;
    }
    const next = jump(s.over ? createRunner(s.width) : s);
    stateRef.current = next;
    // `jump` hands back the same object when it declines — mid-air, say — so this is the
    // one place that knows a press actually became a jump. Sound only when it did.
    if (next !== s) playJump();
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Leave the keyboard alone when a control has focus: Space is how a focused button
      // is pressed, and preventDefault here would swallow that and jump instead.
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest('button, a, input, select, textarea, [contenteditable]')
      ) {
        return;
      }
      // Any key counts as someone being here, not just the ones the game acts on.
      lastInputRef.current = performance.now();
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        press();
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        fastFallRef.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ArrowDown' || e.code === 'KeyS')
        fastFallRef.current = false;
    };
    // Down held, then released somewhere else — another view, another app — never sends a
    // keyup here, and the fast fall stayed on for good: roughly half the apex, so nothing
    // tall could be cleared again and every run ended on the first tower.
    const release = () => {
      fastFallRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
    };
  }, [active, press]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const c = canvas.getContext('2d');
    if (!c) return;

    let frame = 0;
    let last = performance.now();
    let lastOpacity = 1;
    let cssWidth = 0;
    // Rebuilt only when the sky turns over, which is a handful of times in a long run —
    // not per frame, where it would allocate two of these sixty times a second.
    let sky = dark;
    let p = palette(sky);
    let landmarks: LandmarkPaint = landmarkPaint(sky);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cssWidth = Math.max(320, Math.round(canvas.clientWidth));
      HEIGHT = Math.max(260, Math.round(canvas.clientHeight));
      GROUND_Y = Math.max(140, HEIGHT - ROAD_DEPTH);
      SKY_BAND = GROUND_Y - 26;
      // Published so the status line can sit centred in the ground band without a second
      // copy of this number in the stylesheet.
      document.documentElement.style.setProperty(
        '--game-ground',
        `${HEIGHT - GROUND_Y}px`,
      );
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      stateRef.current = { ...stateRef.current, width: cssWidth };
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // `night` rather than the `dark` prop: the run turns the sky over as it goes, and the
    // moon and the star field have to turn with it — a crescent hanging in a daylight sky
    // is what the prop gave.
    const draw = (
      s: RunnerState,
      now: number,
      demo: boolean,
      night: boolean,
    ) => {
      c.clearRect(0, 0, cssWidth, HEIGHT);

      drawOrb(c, p, cssWidth, night);
      if (night) drawStars(c, p, skyRef.current.stars, cssWidth, s.dist, now);
      else drawClouds(c, p, skyRef.current.clouds, cssWidth, s.dist);

      // The ground, styled as the site footer is: its border-top as a hairline running the
      // full width, with its translucent panel continuing below to the bottom of the
      // screen. The footer has no road markings and neither does this — the landmarks
      // going past are what carry the speed.
      c.fillStyle = p.groundFill;
      c.fillRect(0, GROUND_Y + 1, cssWidth, HEIGHT - GROUND_Y - 1);
      c.strokeStyle = p.groundLine;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, GROUND_Y + 0.5);
      c.lineTo(cssWidth, GROUND_Y + 0.5);
      c.stroke();

      for (const o of s.obstacles) {
        if (o.kind === 'bus') drawBus(c, o);
        else drawLandmark(c, o.kind, o.x, GROUND_Y, o.h, landmarks);
      }
      // Read before the lens is drawn, not just for the readout: how hard it looks to be
      // working is driven by the same number.
      const score = runnerScore(s);
      drawLens(c, PLAYER_X, GROUND_Y - s.y - FOOT_DROP, p, {
        phase: s.dist / 16, // a stride per ~100px, so the legs keep up as it speeds up
        airborne: s.y > 0,
        running: s.started && !s.over,
        over: s.over,
        // A blink every few seconds, over in a snap, so it reads as alive and not as a fault.
        blinking: !s.over && now % 4200 < 120,
        dist: s.dist,
        score,
      });

      // Inset from the corner rather than tucked into it — flush against the edges it read
      // as clipped. The gap between the two is wide enough for five digits plus air.
      c.font = '500 15px ui-monospace, SFMono-Regular, Menlo, monospace';
      c.textAlign = 'right';
      c.fillStyle = p.dim;
      // The best never absorbs a demo run, so it is not maxed against the live score here
      // either — the number on the right is the demo's, and it is not competing.
      const best = demo ? bestRef.current : Math.max(bestRef.current, score);
      c.fillText(`HI ${String(best).padStart(5, '0')}`, cssWidth - 122, 34);
      // The live score in the brand red, so the number that is moving is the one that
      // catches the eye; the best stays in the same ink as the rest of the furniture.
      c.fillStyle = p.red;
      c.fillText(String(score).padStart(5, '0'), cssWidth - 28, 34);

      // The prompt lives on the canvas rather than beside it, so the screen stays one
      // picture and one line of status underneath. Dead centre of the window: the sky is
      // empty there in both themes — clear of the ink sweep above and the ground below —
      // and it is the one thing on this screen the player has to act on.
      // Shown through the demo too, and that is the point of it: someone watching the lens
      // play itself has to be told the game is theirs for the taking. Never "again" while
      // the demo is on — the run that just ended was not theirs.
      if (!s.started || s.over || demo) {
        c.font =
          '500 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = p.dim;
        c.fillText(
          s.over && !demo ? 'Press Space to play again' : 'Press Space to play',
          cssWidth / 2,
          HEIGHT / 2,
        );
        c.textBaseline = 'alphabetic';
      }
    };

    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!lastInputRef.current) lastInputRef.current = now;
      const before = stateRef.current;
      let next = stepRunner(before, dt, fastFallRef.current, Math.random);

      if (next.over && !before.over) {
        // A demo crash is silent and scores nothing: it is a screen playing to an empty
        // room, and its runs are not the player's to be measured against.
        if (!demoRef.current) {
          playCrash();
          const crashed = runnerScore(next);
          if (crashed > bestRef.current) {
            bestRef.current = crashed;
            writeBest(crashed);
          }
        }
      }

      // Nobody has touched it in a while and it is not mid-run: let it play itself, so the
      // screen someone is waiting in front of is doing something.
      if (
        !demoRef.current &&
        (!next.started || next.over) &&
        now - lastInputRef.current > DEMO_AFTER_MS
      ) {
        demoRef.current = true;
        demoRestartRef.current = 0;
        demoTargetRef.current = demoStintTarget(Math.random);
        next = jump(createRunner(next.width));
      }
      if (demoRef.current) {
        const fade = fadeRef.current;
        if (fade.phase === 'out' && now - fade.at >= DEMO_FADE_MS) {
          // Gone. Swap in the next run behind the blank and bring it back up.
          demoTargetRef.current = demoStintTarget(Math.random);
          next = jump(createRunner(next.width));
          fadeRef.current = { phase: 'in', at: now };
        } else if (fade.phase === 'in' && now - fade.at >= DEMO_FADE_MS) {
          fadeRef.current = { phase: 'none', at: 0 };
        } else if (fade.phase === 'none') {
          if (next.over) {
            // It got something wrong. A beat to show what happened, then round again.
            if (!demoRestartRef.current) demoRestartRef.current = now + 1400;
            else if (now >= demoRestartRef.current) {
              demoRestartRef.current = 0;
              demoTargetRef.current = demoStintTarget(Math.random);
              next = jump(createRunner(next.width));
            }
          } else if (demoStintOver(next, demoTargetRef.current)) {
            // Its stint is up. Bowing out on a fade rather than on a crash: the demo is
            // not meant to look like it lost, only like it finished.
            fadeRef.current = { phase: 'out', at: now };
          } else if (demoShouldJump(next)) {
            next = jump(next);
          }
        } else if (demoShouldJump(next)) {
          // Still playing properly through the fade in, so it is already up to speed by
          // the time anyone can see it.
          next = jump(next);
        }
      }

      stateRef.current = next;

      // Day into night and back, as a straight cut. Dipping the frame through black to
      // cross between them read as the game glitching rather than as the sun going down.
      const wantDark = skyAt(next, dark);
      if (wantDark !== sky) {
        sky = wantDark;
        p = palette(sky);
        landmarks = landmarkPaint(sky);
        setNight(sky);
        onSkyRef.current?.(sky);
      }

      // Applied to the canvas rather than to every draw call: the sky, the ground, the
      // sweat and the stars all set their own alpha, and an outer globalAlpha would be
      // clobbered by each of them in turn.
      const fade = fadeRef.current;
      const t =
        fade.phase === 'none' ? 1 : Math.min(1, (now - fade.at) / DEMO_FADE_MS);
      // The demo's changeover is the only thing that ever fades the frame.
      const opacity =
        fade.phase === 'out' ? 1 - t : fade.phase === 'in' ? t : 1;
      if (Math.abs(opacity - lastOpacity) > 0.01 || opacity === 1) {
        lastOpacity = opacity;
        canvas.style.opacity = opacity === 1 ? '' : String(opacity);
      }

      draw(next, now, demoRef.current, sky);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      // A changeover caught mid-fade would otherwise leave the canvas dimmed for whatever
      // comes back — the theme flips through this effect, and the screen can be re-shown.
      canvas.style.opacity = '';
      fadeRef.current = { phase: 'none', at: 0 };
    };
  }, [active, dark]);

  // Hand the audio device back when the screen goes; the next jump opens a new context.
  useEffect(() => closeSound, []);

  return (
    <>
      {/* Behind the canvas, which is drawn on a transparent ground so the ink shows
          through it — the sky is painted, the city and the runner are not. */}
      <InkSky dark={night} />
      <canvas ref={canvasRef} className="runner-canvas" onPointerDown={press} />
    </>
  );
}
