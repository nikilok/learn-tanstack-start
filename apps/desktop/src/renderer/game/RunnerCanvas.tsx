import { useCallback, useEffect, useRef } from 'react';

import {
  createRunner,
  jump,
  PLAYER_R,
  PLAYER_X,
  runnerScore,
  stepRunner,
} from './runner';
import type { Obstacle, RunnerState } from './runner';
import { makeClouds, makeStars } from './sky';
import type { Cloud, Star } from './sky';
import { closeSound, playCrash, playJump } from './sound';

const HEIGHT = 210; // CSS px; the ground sits a little above the bottom edge
const GROUND_Y = HEIGHT - 54;
const SKY_BAND = GROUND_Y - 26; // how far down the sky's scenery may reach
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
  wall: string; // the face of a building
  wallTop: string; // its lit top edge, which is what gives it any solidity
  window: string; // an unlit window
  windowLit: string;
  beacon: string; // the mast light
  line: string; // the ground
  dim: string; // the high score and the prompt, neither of which is the point
  score: string; // the run you are on, which is
  sky: string; // the stars
  cloud: string;
  orb: string; // the moon, or the sun
  orbGlow: string;
  navy: string;
  red: string;
}

function palette(dark: boolean): Palette {
  return dark
    ? {
        wall: 'rgba(231,233,238,0.13)',
        wallTop: 'rgba(231,233,238,0.32)',
        window: 'rgba(231,233,238,0.07)',
        windowLit: 'rgba(255,206,138,0.75)',
        beacon: 'rgba(248,113,113,0.9)',
        line: 'rgba(231,233,238,0.34)',
        dim: 'rgba(231,233,238,0.3)',
        score: 'rgba(231,233,238,0.72)',
        sky: 'rgba(255,255,255,0.9)',
        cloud: 'rgba(226,232,255,0.10)',
        orb: 'rgba(233,236,255,0.85)',
        orbGlow: 'rgba(180,200,255,0.10)',
        navy: '#e0e7ff',
        red: '#f87171',
      }
    : {
        wall: 'rgba(31,36,48,0.14)',
        wallTop: 'rgba(31,36,48,0.3)',
        window: 'rgba(31,36,48,0.1)',
        windowLit: 'rgba(31,36,48,0.34)',
        beacon: 'rgba(200,16,46,0.6)',
        line: 'rgba(31,36,48,0.3)',
        dim: 'rgba(31,36,48,0.32)',
        score: 'rgba(31,36,48,0.75)',
        sky: 'rgba(255,255,255,0.95)',
        // Blue-grey, not white: a white cloud on the near-white day sky is invisible.
        cloud: 'rgba(88,124,190,0.2)',
        orb: 'rgba(255,214,140,0.85)',
        orbGlow: 'rgba(255,196,120,0.16)',
        navy: '#001c55',
        red: '#c8102e',
      };
}

const HIP_Y = PLAYER_R * 0.6; // hips, below the lens's centre
const LEG_LEN = 13;
const STRIDE = 1; // radians either side of straight down, at the top of the swing
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

/** One leg from its hip, swung to `angle` (0 = straight down), with a foot on the end. */
function drawLeg(
  c: CanvasRenderingContext2D,
  p: Palette,
  hipX: number,
  angle: number,
): void {
  const hipY = HIP_Y;
  const footX = hipX + Math.sin(angle) * LEG_LEN;
  const footY = hipY + Math.cos(angle) * LEG_LEN;
  c.strokeStyle = p.navy;
  c.lineWidth = 3.4;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(hipX, hipY);
  c.lineTo(footX, footY);
  c.lineTo(footX + 4.5, footY); // a little foot, pointing the way it is going
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
  const r = airborne ? 3.4 : 3;
  for (const x of [-PLAYER_R * 0.3, PLAYER_R * 0.34]) {
    if (over) {
      c.strokeStyle = '#12203f';
      c.lineWidth = 1.6;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - 2.2, y - 2.2);
      c.lineTo(x + 2.2, y + 2.2);
      c.moveTo(x + 2.2, y - 2.2);
      c.lineTo(x - 2.2, y + 2.2);
      c.stroke();
      continue;
    }
    if (blinking) {
      c.strokeStyle = '#12203f';
      c.lineWidth = 1.6;
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
    c.lineWidth = 0.7;
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

interface Pose {
  /** Run cycle, in radians. */
  phase: number;
  airborne: boolean;
  running: boolean;
  over: boolean;
  blinking: boolean;
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
    pose.airborne || !pose.running ? 0 : Math.abs(Math.cos(pose.phase)) * 1.5;

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
  c.strokeStyle = p.navy;
  c.lineWidth = 4;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(Math.cos(arm) * PLAYER_R * 0.7, Math.sin(arm) * PLAYER_R * 0.7);
  c.lineTo(handX, handY);
  c.stroke();
  c.fillStyle = p.navy;
  c.beginPath();
  c.arc(handX, handY, 3.4, 0, Math.PI * 2);
  c.fill();

  c.beginPath();
  c.arc(0, 0, PLAYER_R, 0, Math.PI * 2);
  c.fill();

  drawFlag(c, p);
  drawEyes(c, pose.over, pose.airborne, pose.blinking);
  c.restore();
}

// A London bus is red whatever the app's theme is, so its colours are its own rather than
// the palette's. Front faces left, into the direction the runner is coming from.
const BUS_BODY = '#cc1f2d';
const BUS_SHADE = '#9e141f';
const BUS_BAND = '#f3ece1';
const BUS_GLASS = '#cfe0f5';
const BUS_TYRE = '#15161c';

/** The double-decker: two rows of glass, a cream band between the decks, and wheels on the road. */
function drawBus(c: CanvasRenderingContext2D, o: Obstacle): void {
  const top = GROUND_Y - o.h;
  const wheelR = 3.2;
  const bodyH = o.h - wheelR; // the body rides above the axles
  const r = 3;

  c.fillStyle = BUS_BODY;
  c.beginPath();
  c.roundRect(o.x, top, o.w, bodyH, r);
  c.fill();

  // Cream band on the deck line, which is what makes it read as a double-decker rather
  // than a red box.
  const deck = top + bodyH * 0.5;
  c.fillStyle = BUS_BAND;
  c.fillRect(o.x, deck - 1.2, o.w, 2.4);

  // Upper deck: a run of windows, with the front one wrapped round the nose.
  c.fillStyle = BUS_GLASS;
  const upperY = top + 3.5;
  const upperH = bodyH * 0.5 - 6;
  c.fillRect(o.x + 2.5, upperY, 7, upperH); // windscreen
  for (let x = o.x + 12; x < o.x + o.w - 4; x += 8) {
    c.fillRect(x, upperY, 5.5, upperH);
  }

  // Lower deck: windscreen, then windows, then the open platform at the back.
  const lowerY = deck + 2.4;
  const lowerH = bodyH * 0.5 - 6;
  c.fillRect(o.x + 2.5, lowerY, 8, lowerH);
  for (let x = o.x + 13; x < o.x + o.w - 8; x += 8) {
    c.fillRect(x, lowerY, 5.5, lowerH);
  }
  c.fillStyle = BUS_SHADE;
  c.fillRect(o.x + o.w - 6.5, lowerY, 4.5, lowerH); // the rear platform, in shadow

  // Destination blind over the windscreen, and a headlight below it.
  c.fillStyle = BUS_BAND;
  c.fillRect(o.x + 2.5, top + 1.2, 9, 2);
  c.fillStyle = '#ffe9b0';
  c.beginPath();
  c.arc(o.x + 3, GROUND_Y - wheelR - 2.5, 1.3, 0, Math.PI * 2);
  c.fill();

  // Resting on the road rather than sunk through it: the ground line is drawn at
  // GROUND_Y + 1, so the tyres have to bottom out just above it.
  c.fillStyle = BUS_TYRE;
  for (const wx of [o.x + o.w * 0.22, o.x + o.w * 0.78]) {
    c.beginPath();
    c.arc(wx, GROUND_Y - wheelR - 0.8, wheelR, 0, Math.PI * 2);
    c.fill();
  }
}

/** One building: a silhouette with a lit top edge, a window grid, and something on the roof. */
function drawBuilding(
  c: CanvasRenderingContext2D,
  o: Obstacle,
  p: Palette,
): void {
  const top = GROUND_Y - o.h;
  c.fillStyle = p.wall;
  c.fillRect(o.x, top, o.w, o.h);
  c.fillStyle = p.wallTop;
  c.fillRect(o.x, top, o.w, 1.5); // the parapet catching the light

  if (o.roof === 1) {
    // A mast with a beacon on it.
    const mx = Math.round(o.x + o.w / 2);
    c.strokeStyle = p.wallTop;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(mx, top);
    c.lineTo(mx, top - 9);
    c.stroke();
    c.fillStyle = p.beacon;
    c.beginPath();
    c.arc(mx, top - 10.5, 1.6, 0, Math.PI * 2);
    c.fill();
  } else if (o.roof === 2) {
    // A stepped setback with a water tank on it.
    const bw = Math.max(8, o.w * 0.45);
    const bx = o.x + (o.w - bw) / 2;
    c.fillStyle = p.wall;
    c.fillRect(bx, top - 7, bw, 7);
    c.fillStyle = p.wallTop;
    c.fillRect(bx, top - 7, bw, 1.5);
    c.fillRect(bx + bw * 0.3, top - 11, bw * 0.4, 4);
  }

  // Windows. The lit pattern is derived from the building's own dimensions, so it holds
  // steady as it scrolls instead of flickering a new arrangement every frame.
  const cols = Math.max(1, Math.floor((o.w - 5) / 8));
  const rows = o.lights;
  for (let row = 0; row < rows; row++) {
    const y = top + 6 + row * 10;
    if (y > GROUND_Y - 6) break;
    for (let col = 0; col < cols; col++) {
      const lit = (row * 31 + col * 17 + o.w * 7 + o.h) % 5 < 2;
      c.fillStyle = lit ? p.windowLit : p.window;
      c.fillRect(o.x + 4 + col * 8, y, 3.5, 4.5);
    }
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
  for (const s of stars) {
    const x = (((s.x * width - drift) % width) + width) % width;
    const y = 8 + s.y * SKY_BAND;
    // Each star breathes on its own clock; the amplitude is small enough to read as air.
    const twinkle = 0.55 + 0.45 * Math.sin(now / 900 + s.phase);
    c.globalAlpha = twinkle * (s.bright ? 1 : 0.7);
    c.fillStyle = p.sky;
    c.beginPath();
    c.arc(x, y, s.r, 0, Math.PI * 2);
    c.fill();
    if (s.bright) {
      // A short cross of light, which is what separates the bright few from the dots.
      c.strokeStyle = p.sky;
      c.lineWidth = 0.6;
      c.globalAlpha = twinkle * 0.5;
      const arm = s.r * 3;
      c.beginPath();
      c.moveTo(x - arm, y);
      c.lineTo(x + arm, y);
      c.moveTo(x, y - arm);
      c.lineTo(x, y + arm);
      c.stroke();
    }
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
  for (const cloud of clouds) {
    const x = (((cloud.x * width - drift) % width) + width) % width;
    const y = 14 + cloud.y * (SKY_BAND * 0.7);
    // Every puff into one path and one fill: filling them separately builds the alpha up
    // where they overlap, and a translucent cloud comes out with seams across it.
    c.beginPath();
    for (const puff of cloud.puffs) {
      const px = x + puff.dx * cloud.scale;
      const py = y + puff.dy * cloud.scale;
      c.moveTo(px + puff.r * cloud.scale * 0.6, py);
      c.arc(px, py, puff.r * cloud.scale * 0.6, 0, Math.PI * 2);
    }
    c.fill();
  }
}

/** The moon or the sun, whichever the theme calls for, parked in the upper right. */
function drawOrb(
  c: CanvasRenderingContext2D,
  p: Palette,
  width: number,
  dark: boolean,
): void {
  const cx = width - 110;
  // Sat low enough that its glow clears the score along the top edge, which it used to
  // wash straight through.
  const cy = 64;
  const r = 15;
  // A gradient, not a flat disc: a translucent circle at a fixed alpha has a hard edge and
  // reads as a grey plate behind the moon rather than as light coming off it.
  const glow = c.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.8);
  glow.addColorStop(0, p.orbGlow);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow;
  c.beginPath();
  c.arc(cx, cy, r * 2.8, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = p.orb;
  if (!dark) {
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    return;
  }
  // A crescent: the disc, with a second arc swung back across it to bite the lit side out.
  c.beginPath();
  c.arc(cx, cy, r, Math.PI * 0.42, Math.PI * 1.58);
  c.arc(cx + r * 0.52, cy, r * 0.92, Math.PI * 1.42, Math.PI * 0.58, true);
  c.closePath();
  c.fill();
}

export interface RunnerCanvasProps {
  /** False while the screen is hidden, so nothing animates behind a closed overlay. */
  active: boolean;
  dark: boolean;
}

/** The endless runner itself: input, the frame loop, and drawing. All of the rules live in runner.ts. */
export function RunnerCanvas({ active, dark }: RunnerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<RunnerState>(createRunner(600));
  const fastFallRef = useRef(false);
  const bestRef = useRef(readBest());
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
    const s = stateRef.current;
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [active, press]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const c = canvas.getContext('2d');
    if (!c) return;

    let frame = 0;
    let last = performance.now();
    let cssWidth = 0;
    const p = palette(dark);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cssWidth = Math.max(320, Math.round(canvas.clientWidth));
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      stateRef.current = { ...stateRef.current, width: cssWidth };
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (s: RunnerState, now: number) => {
      c.clearRect(0, 0, cssWidth, HEIGHT);

      drawOrb(c, p, cssWidth, dark);
      if (dark) drawStars(c, p, skyRef.current.stars, cssWidth, s.dist, now);
      else drawClouds(c, p, skyRef.current.clouds, cssWidth, s.dist);

      // Ground: dashes that scroll, which is what actually sells the speed.
      c.strokeStyle = p.line;
      c.lineWidth = 2;
      c.setLineDash([12, 10]);
      c.lineDashOffset = -(s.dist % 22);
      c.beginPath();
      c.moveTo(0, GROUND_Y + 1);
      c.lineTo(cssWidth, GROUND_Y + 1);
      c.stroke();
      c.setLineDash([]);

      for (const o of s.obstacles) {
        if (o.kind === 'bus') drawBus(c, o);
        else drawBuilding(c, o, p);
      }
      drawLens(c, PLAYER_X, GROUND_Y - s.y - FOOT_DROP, p, {
        phase: s.dist / 16, // a stride per ~100px, so the legs keep up as it speeds up
        airborne: s.y > 0,
        running: s.started && !s.over,
        over: s.over,
        // A blink every few seconds, over in a snap, so it reads as alive and not as a fault.
        blinking: !s.over && now % 4200 < 120,
      });

      const score = runnerScore(s);
      c.font = '500 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      c.textAlign = 'right';
      c.fillStyle = p.dim;
      const best = Math.max(bestRef.current, score);
      c.fillText(`HI ${String(best).padStart(5, '0')}`, cssWidth - 74, 13);
      c.fillStyle = p.score;
      c.fillText(String(score).padStart(5, '0'), cssWidth - 4, 13);

      // The prompt lives on the canvas rather than beside it, so the screen stays one
      // picture and one line of status underneath.
      if (!s.started || s.over) {
        c.font =
          '400 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        c.textAlign = 'center';
        c.fillStyle = p.dim;
        c.fillText(
          s.over ? 'Press Space to play again' : 'Press Space to play',
          cssWidth / 2,
          GROUND_Y - 58,
        );
      }
    };

    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const before = stateRef.current;
      const next = stepRunner(before, dt, fastFallRef.current, Math.random);
      stateRef.current = next;
      if (next.over && !before.over) {
        playCrash();
        const score = runnerScore(next);
        if (score > bestRef.current) {
          bestRef.current = score;
          writeBest(score);
        }
      }
      draw(next, now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, dark]);

  // Hand the audio device back when the screen goes; the next jump opens a new context.
  useEffect(() => closeSound, []);

  return (
    <canvas
      ref={canvasRef}
      className="runner-canvas"
      style={{ height: HEIGHT }}
      onPointerDown={press}
    />
  );
}
