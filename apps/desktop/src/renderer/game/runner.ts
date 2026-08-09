/**
 * The little endless runner on the stand-in screen: a search lens hopping the skyline
 * while the app waits to be let back in. Pure state in, pure state out — no canvas, no
 * timers, no randomness of its own — so the physics and the collisions are unit-testable
 * and RunnerCanvas.tsx is left with nothing but drawing.
 */

/** What sits on top of a building: 0 flat, 1 a mast, 2 a stepped setback with a tank. */
export type Roof = 0 | 1 | 2;

/** What the runner has to clear. A bus is drawn differently but behaves the same. */
export type ObstacleKind = 'building' | 'bus';

export interface Obstacle {
  x: number; // left edge, in world px from the canvas's left
  w: number;
  h: number;
  /** Window rows, so a building keeps the same lit pattern as it scrolls. */
  lights: number;
  roof: Roof;
  kind: ObstacleKind;
}

export interface RunnerState {
  width: number; // canvas width; obstacles enter here and leave off the left
  dist: number; // px travelled, which is also the score's basis
  speed: number; // px/s
  y: number; // lens height above the ground line
  vy: number;
  obstacles: Obstacle[];
  nextSpawn: number; // dist at which the next building enters
  started: boolean;
  over: boolean;
}

export const PLAYER_X = 74; // fixed distance from the left edge
export const PLAYER_R = 15;

const GRAVITY = 2400;
const JUMP_V = 780;
/** How high the feet reach at the top of a jump. Nothing spawned may come near it. */
export const JUMP_APEX = (JUMP_V * JUMP_V) / (2 * GRAVITY);
const FAST_FALL = 2800; // extra pull while the down key is held
const SPEED_START = 300;
const SPEED_MAX = 760;
const SPEED_RAMP = 16; // px/s gained per second
const SCORE_PER_PX = 1 / 18;
const HIT_INSET = 4; // forgiveness, so a near miss reads as a miss

// Low and wide, or tall and narrow. Nothing here is unclearable; the run gets hard
// through pace and spacing instead, which is the part a player can actually read.
const SHAPES: readonly {
  w: number;
  h: number;
  roof: Roof;
  kind: ObstacleKind;
}[] = [
  { w: 18, h: 34, roof: 0, kind: 'building' },
  { w: 26, h: 52, roof: 1, kind: 'building' },
  // The bus: long and low against the towers, at roughly a Routemaster's proportions.
  { w: 46, h: 25, roof: 0, kind: 'bus' },
  { w: 40, h: 30, roof: 2, kind: 'building' },
  { w: 22, h: 66, roof: 1, kind: 'building' },
];

/** A fresh run, idle until the first jump. */
export function createRunner(width: number): RunnerState {
  return {
    width,
    dist: 0,
    speed: SPEED_START,
    y: 0,
    vy: 0,
    obstacles: [],
    nextSpawn: 260,
    started: false,
    over: false,
  };
}

/** Points shown to the player. */
export function runnerScore(s: RunnerState): number {
  return Math.floor(s.dist * SCORE_PER_PX);
}

/** Starts the run, or launches the lens when it is on the ground. Ignored mid-air. */
export function jump(s: RunnerState): RunnerState {
  if (s.over) return s;
  if (!s.started) return { ...s, started: true, vy: JUMP_V };
  if (s.y > 0) return s;
  return { ...s, vy: JUMP_V };
}

/** True when the lens overlaps a building. */
function hits(y: number, o: Obstacle): boolean {
  const left = PLAYER_X - PLAYER_R + HIT_INSET;
  const right = PLAYER_X + PLAYER_R - HIT_INSET;
  if (o.x + o.w <= left || o.x >= right) return false;
  return y + HIT_INSET < o.h;
}

/** Picks the next building, entering just off the right edge. */
function spawn(width: number, rnd: () => number): Obstacle {
  const shape = SHAPES[Math.floor(rnd() * SHAPES.length)] as (typeof SHAPES)[0];
  return {
    x: width + 20,
    w: shape.w,
    h: shape.h,
    lights: Math.max(1, Math.floor((shape.h - 8) / 12)),
    roof: shape.roof,
    kind: shape.kind,
  };
}

/**
 * Advances one frame. `dt` is clamped, so a stalled tab resumes where it left off rather
 * than teleporting the lens through whatever was in front of it.
 */
export function stepRunner(
  s: RunnerState,
  dtSeconds: number,
  fastFall: boolean,
  rnd: () => number,
): RunnerState {
  if (!s.started || s.over) return s;
  const dt = Math.min(Math.max(dtSeconds, 0), 0.05);
  const speed = Math.min(s.speed + SPEED_RAMP * dt, SPEED_MAX);
  const dist = s.dist + speed * dt;

  const g = GRAVITY + (fastFall && s.y > 0 ? FAST_FALL : 0);
  let vy = s.vy - g * dt;
  let y = s.y + vy * dt;
  if (y <= 0) {
    y = 0;
    vy = 0;
  }

  const moved = speed * dt;
  const obstacles = s.obstacles
    .map((o) => ({ ...o, x: o.x - moved }))
    .filter((o) => o.x + o.w > -20);

  let nextSpawn = s.nextSpawn;
  if (dist >= nextSpawn) {
    obstacles.push(spawn(s.width, rnd));
    // Room to land and set up again, scaled to the pace so it stays fair as it speeds up.
    nextSpawn = dist + speed * (0.62 + rnd() * 0.6);
  }

  return {
    ...s,
    dist,
    speed,
    y,
    vy,
    obstacles,
    nextSpawn,
    over: obstacles.some((o) => hits(y, o)),
  };
}
