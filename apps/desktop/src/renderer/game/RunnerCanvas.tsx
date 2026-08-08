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

const HEIGHT = 210; // CSS px; the ground sits a little above the bottom edge
const GROUND_Y = HEIGHT - 54;
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
  ink: string; // the buildings you have to clear
  far: string; // the skyline behind them
  dim: string; // the high score and the prompt, neither of which is the point
  score: string; // the run you are on, which is
  line: string;
  navy: string;
  red: string;
  lit: string;
}

function palette(dark: boolean): Palette {
  return dark
    ? {
        ink: 'rgba(231,233,238,0.42)',
        far: 'rgba(231,233,238,0.12)',
        dim: 'rgba(231,233,238,0.3)',
        score: 'rgba(231,233,238,0.72)',
        line: 'rgba(231,233,238,0.34)',
        navy: '#e0e7ff',
        red: '#f87171',
        lit: 'rgba(248,113,113,0.5)',
      }
    : {
        ink: 'rgba(31,36,48,0.5)',
        far: 'rgba(31,36,48,0.11)',
        dim: 'rgba(31,36,48,0.32)',
        score: 'rgba(31,36,48,0.75)',
        line: 'rgba(31,36,48,0.3)',
        navy: '#001c55',
        red: '#c8102e',
        lit: 'rgba(200,16,46,0.32)',
      };
}

const HIP_Y = PLAYER_R * 0.6; // hips, below the lens's centre
const LEG_LEN = 13;
const STRIDE = 1; // radians either side of straight down, at the top of the swing
// Centre of the lens to the ground when standing. The physics tracks the feet, so the
// body is drawn this far above them and the whole character clears an obstacle together.
const FOOT_DROP = HIP_Y + LEG_LEN;

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

interface Pose {
  /** Run cycle, in radians. */
  phase: number;
  airborne: boolean;
  running: boolean;
  over: boolean;
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

  // A flag small enough to be an impression rather than a rendering.
  c.save();
  c.beginPath();
  c.arc(0, 0, PLAYER_R * 0.72, 0, Math.PI * 2);
  c.clip();
  c.fillStyle = '#012169';
  c.fillRect(-PLAYER_R, -PLAYER_R, PLAYER_R * 2, PLAYER_R * 2);
  c.strokeStyle = '#ffffff';
  c.lineWidth = 5;
  c.beginPath();
  c.moveTo(0, -PLAYER_R);
  c.lineTo(0, PLAYER_R);
  c.moveTo(-PLAYER_R, 0);
  c.lineTo(PLAYER_R, 0);
  c.stroke();
  c.strokeStyle = p.red;
  c.lineWidth = 3;
  c.stroke();
  c.restore();
  c.restore();
}

/** One building: a silhouette with a few lit windows. */
function drawBuilding(
  c: CanvasRenderingContext2D,
  o: Obstacle,
  p: Palette,
): void {
  const top = GROUND_Y - o.h;
  c.fillStyle = p.ink;
  c.fillRect(o.x, top, o.w, o.h);
  c.fillStyle = p.lit;
  for (let row = 0; row < o.lights; row++) {
    const y = top + 7 + row * 12;
    for (let col = 0; col < Math.max(1, Math.floor(o.w / 12)); col++) {
      // Deterministic from the building's own shape, so windows don't flicker as it scrolls.
      if ((row + col + o.w) % 3 === 0) continue;
      c.fillRect(o.x + 4 + col * 12, y, 4, 5);
    }
  }
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

  // A press starts the run, jumps, or begins a new one once the last has ended. Restarting
  // launches straight into the next run rather than parking on an idle screen that needs a
  // second press. The whole game lives in a ref: nothing here needs a re-render, and the
  // frame loop owns the draw.
  const press = useCallback(() => {
    const s = stateRef.current;
    stateRef.current = jump(s.over ? createRunner(s.width) : s);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
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

    const draw = (s: RunnerState) => {
      c.clearRect(0, 0, cssWidth, HEIGHT);

      // Skyline: a fraction of the pace, and standing off a horizon a little above the
      // ground line, so distance reads at a glance and it never looks like an obstacle.
      c.fillStyle = p.far;
      const horizon = GROUND_Y - 13;
      const drift = (s.dist * 0.24) % 220;
      for (let i = -1; i < Math.ceil(cssWidth / 220) + 1; i++) {
        const x = i * 220 - drift;
        c.fillRect(x + 20, horizon - 32, 30, 32);
        c.fillRect(x + 60, horizon - 50, 22, 50);
        c.fillRect(x + 94, horizon - 22, 38, 22);
      }

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

      for (const o of s.obstacles) drawBuilding(c, o, p);
      drawLens(c, PLAYER_X, GROUND_Y - s.y - FOOT_DROP, p, {
        phase: s.dist / 16, // a stride per ~100px, so the legs keep up as it speeds up
        airborne: s.y > 0,
        running: s.started && !s.over,
        over: s.over,
      });

      const score = runnerScore(s);
      c.font = '500 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      c.textAlign = 'right';
      c.fillStyle = p.dim;
      const best = Math.max(bestRef.current, score);
      c.fillText(`HI ${String(best).padStart(5, '0')}`, cssWidth - 74, 18);
      c.fillStyle = p.score;
      c.fillText(String(score).padStart(5, '0'), cssWidth - 4, 18);

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
        const score = runnerScore(next);
        if (score > bestRef.current) {
          bestRef.current = score;
          writeBest(score);
        }
      }
      draw(next);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, dark]);

  return (
    <canvas
      ref={canvasRef}
      className="runner-canvas"
      style={{ height: HEIGHT }}
      onPointerDown={press}
    />
  );
}
