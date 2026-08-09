/**
 * Sweat off the lens once a run has been going a while.
 *
 * It is the only thing on screen that says how long you have been at this — the score is a
 * number you have to read, the pace tops out early, and the landmarks cycle. So it is
 * driven by score rather than by time or speed: it should arrive at a moment the player can
 * point at, and it should still be there on a long run that has settled into its rhythm.
 *
 * Stateless on purpose. Every bead's position is a function of distance travelled, the same
 * way the stars and clouds are, so nothing here has to be stored in the run's state or
 * cleaned up when it ends — and it is pure, so the rules are unit-testable.
 */

/** One bead in flight, in px from the centre of the lens. Negative y is up. */
export interface Drop {
  x: number;
  y: number;
  /** 0 as it leaves the head, 1 as it fades out. The caller sizes and fades on it. */
  life: number;
}

/** Score before the first bead shows — long enough that it reads as earned. */
const FROM = 120;
/** Score by which it is working as hard as it will ever look. */
const FULL = 700;
const MAX_DROPS = 5;
/** Px of ground travelled per bead's whole flight, which is what paces the flicking. */
const FLIGHT_PX = 300;
/** How far a bead gets from the head before it is gone. */
const REACH = 26;
/** Carried backwards by the run, and pulled down as it goes. */
const DRIFT = 16;
const FALL = 20;

/** How many beads are in the air at once — none early, more as the run goes on. */
export function sweatCount(score: number): number {
  if (score < FROM) return 0;
  const t = Math.min(1, (score - FROM) / (FULL - FROM));
  return Math.max(1, Math.round(t * MAX_DROPS));
}

/**
 * The beads in flight right now. `radius` is the lens they are leaving, so they start at
 * its rim rather than inside its face.
 */
export function sweatDrops(
  dist: number,
  score: number,
  radius: number,
): Drop[] {
  const count = sweatCount(score);
  const drops: Drop[] = [];
  for (let i = 0; i < count; i++) {
    // Each bead is the same loop offset along, so they flick one after another instead of
    // pulsing together.
    const life = (((dist / FLIGHT_PX + i / count) % 1) + 1) % 1;
    // Fanned across the top of the head so it never looks one-sided.
    const spread = count === 1 ? 0.5 : i / (count - 1);
    const angle = -Math.PI * (0.18 + 0.64 * spread);
    const out = radius * 0.9 + REACH * life;
    drops.push({
      x: Math.cos(angle) * out - DRIFT * life,
      y: Math.sin(angle) * out + FALL * life * life,
      life,
    });
  }
  return drops;
}
