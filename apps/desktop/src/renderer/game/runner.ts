/**
 * The little endless runner on the stand-in screen: a search lens hopping the London
 * skyline while the app waits to be let back in. Pure state in, pure state out — no canvas,
 * no timers, no randomness of its own — so the physics and the collisions are unit-testable
 * and RunnerCanvas.tsx is left with nothing but drawing.
 */
import { LANDMARKS } from '@ss/skyline';
import type { LandmarkId } from '@ss/skyline';

/**
 * What the runner has to clear: one of the footer skyline's landmarks, or a bus.
 * The landmarks are drawn from the shared geometry, so the obstacles here are literally
 * the ones standing in the site's footer.
 */
export type ObstacleKind = LandmarkId | 'bus';

export interface Obstacle {
  x: number; // left edge, in world px from the canvas's left
  w: number;
  h: number;
  kind: ObstacleKind;
}

export interface RunnerState {
  width: number; // canvas width; obstacles enter here and leave off the left
  dist: number; // px travelled, which is also the score's basis
  speed: number; // px/s
  y: number; // lens height above the ground line
  vy: number;
  obstacles: Obstacle[];
  nextSpawn: number; // dist at which the next landmark enters
  started: boolean;
  over: boolean;
}

/**
 * The whole game is drawn at this multiple of its original size. It went up when the
 * obstacles became landmarks: Big Ben is a slender tower, and at the old scale it was nine
 * pixels wide — a stick, with no clock on it. Every length below is in scaled px, so the
 * feel is unchanged and only the size on screen moved.
 */
const SCALE = 2.4;

export const PLAYER_X = 178; // fixed distance from the left edge
// Deliberately short of a full scale-up: the lens reads as something running past the
// landmarks rather than as another one of them.
export const PLAYER_R = 26;

const GRAVITY = 2400 * SCALE;
const JUMP_V = 780 * SCALE;
/** How high the feet reach at the top of a jump. Nothing spawned may come near it. */
export const JUMP_APEX = (JUMP_V * JUMP_V) / (2 * GRAVITY);
const FAST_FALL = 2800 * SCALE; // extra pull while the down key is held
/** Points per px travelled. Divided by the scale, so a run scores as it always did. */
export const SCORE_PER_PX = 1 / (18 * SCALE);
const HIT_INSET = 4 * SCALE; // forgiveness, so a near miss reads as a miss

/*
 * Difficulty is a curve over distance, not a dice roll.
 *
 * Everything below is expressed in score rather than pixels, because score is the only
 * measure of progress the player can see: the run should get harder at moments they can
 * point at. It ramps on three axes at once — pace, spacing and what is out there — so a
 * first run is a gentle jog and a long one is genuinely fast.
 */

/** Score at which the run is at full difficulty; spacing and unlocks ramp across this. */
const FULL_TILT = 950;
/** Score at which the opening ramp reaches the pace the run then settles into. */
export const SPEED_TOPS_AT = 600;
/**
 * Score at which the run starts pressing again, and the score that second climb tops out
 * at. Between the two milestones above it holds one pace: long enough to settle into a
 * rhythm and believe that is the run, which is what makes it register when it picks up.
 */
export const CHALLENGE_FROM = 800;
export const CHALLENGE_FULL = 1600;
/*
 * Pace, in screen px/s, chosen by how long a landmark is in view rather than by how hard
 * the run should be. This screen is what someone stares at while they wait to be let back
 * in, so it is meant to be watchable: a landmark takes ~2.8s to cross at the start, ~1.4s
 * at cruise, and ~1.0s once it is pressing — still over a second of reaction time from an
 * obstacle entering to reaching the lens. They are absolute rather than scaled: the drawing
 * got bigger, the pace deliberately did not follow it.
 */
const SPEED_START = 460;
const SPEED_CRUISE = 950;
const SPEED_MAX = 1250;
/** Seconds between obstacles: a long look at the start, a steady rhythm at full tilt. */
const GAP_EASY = 2.2;
const GAP_HARD = 1.2; // a jump is ~0.65s in the air, so this leaves room to breathe
const GAP_JITTER = 0.28; // ± on the gap, so the rhythm is not metronomic

/** 0 at the start of a run, 1 once it is at full difficulty. */
function progressAt(dist: number): number {
  return Math.min(1, (dist * SCORE_PER_PX) / FULL_TILT);
}

/**
 * How fast the ground moves, in three acts: a ramp up to a cruising pace, a stretch held
 * there, then a second climb to a hard ceiling it never passes.
 *
 * The plateau is the point of it. A run that accelerates without pause never has a pace you
 * learn, and one that tops out for good stops asking anything of you; holding still long
 * enough to feel settled is what makes the second climb read as the run getting harder
 * rather than as the same run continuing.
 */
export function speedAt(dist: number): number {
  const score = dist * SCORE_PER_PX;
  if (score <= SPEED_TOPS_AT) {
    return SPEED_START + (SPEED_CRUISE - SPEED_START) * (score / SPEED_TOPS_AT);
  }
  if (score <= CHALLENGE_FROM) return SPEED_CRUISE;
  const climb = Math.min(
    1,
    (score - CHALLENGE_FROM) / (CHALLENGE_FULL - CHALLENGE_FROM),
  );
  return SPEED_CRUISE + (SPEED_MAX - SPEED_CRUISE) * climb;
}

/**
 * The skyline, dealt out as obstacles. Each is drawn at its own proportions — `w` is
 * derived from the landmark's real bounding box, so nothing is stretched — and `from` is
 * the score it starts appearing at, which is what turns the run into a tour: the Gherkin
 * on the first jump, Tower Bridge only once you have earned it.
 */
function shape(kind: LandmarkId, h: number, from: number) {
  const l = LANDMARKS[kind];
  return { kind, h, from, w: Math.round((l.w * h) / l.h) };
}

const SHAPES: readonly {
  w: number;
  h: number;
  kind: ObstacleKind;
  from: number;
}[] = [
  shape('gherkin', 112, 0),
  shape('eye', 132, 140),
  shape('stPauls', 150, 300),
  // The bus: long and low against the landmarks, at roughly a Routemaster's proportions.
  // The widest thing out there for most of a run, so it waits until the rhythm is there.
  { w: 110, h: 60, kind: 'bus', from: 460 },
  shape('bigBen', 178, 620),
  shape('shard', 198, 800),
  // Both towers and the whole span: the one that needs a jump timed off its leading edge.
  shape('towerBridge', 118, 950),
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
    // A clear run-up before the first obstacle, so the opening is never a scramble.
    nextSpawn: 520 * SCALE,
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

/** True when the lens overlaps an obstacle. */
function hits(y: number, o: Obstacle): boolean {
  const left = PLAYER_X - PLAYER_R + HIT_INSET;
  const right = PLAYER_X + PLAYER_R - HIT_INSET;
  if (o.x + o.w <= left || o.x >= right) return false;
  return y + HIT_INSET < o.h;
}

/** Picks the next obstacle from what the run has unlocked, entering just off the right edge. */
function spawn(width: number, dist: number, rnd: () => number): Obstacle {
  const score = dist * SCORE_PER_PX;
  const unlocked = SHAPES.filter((s) => score >= s.from);
  const shape = unlocked[
    Math.floor(rnd() * unlocked.length)
  ] as (typeof SHAPES)[0];
  return { x: width + 40, w: shape.w, h: shape.h, kind: shape.kind };
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
  const speed = speedAt(s.dist);
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
    .filter((o) => o.x + o.w > -50);

  let nextSpawn = s.nextSpawn;
  if (dist >= nextSpawn) {
    obstacles.push(spawn(s.width, dist, rnd));
    // The gap is in SECONDS of travel, not pixels: as the ground speeds up, the same pixel
    // gap would give less and less time to react. Tightening the seconds on top of that is
    // what actually turns the screw, and it stays above a jump's air time throughout.
    const progress = progressAt(dist);
    const gap = GAP_EASY + (GAP_HARD - GAP_EASY) * progress;
    nextSpawn = dist + speed * (gap + (rnd() - 0.5) * 2 * GAP_JITTER);
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
