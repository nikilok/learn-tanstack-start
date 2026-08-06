// Screening thresholds, read from .env.local and never written here.
//
// A threshold in a public repo is a published budget: read it, stay under it, and nothing ever
// looks twice. Same reasoning as the FW_*_LIMIT ceilings in rules.ts.
//
// Deliberately no fallback values. A default would put the number back in the repo, which is the
// whole thing being avoided, and a permissive one would silently widen what gets profiled.
// Deliberately functions rather than consts, so nothing throws at import and tests that pass
// explicit values never read the environment at all.

/** A required positive integer. */
function envInt(name: string, why: string): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  if (Number.isInteger(n) && n > 0) return n;
  throw new Error(`${name} must be a positive integer in .env.local — ${why}`);
}

/** Requests a fingerprint needs in the window before it is worth profiling. */
export function screenFloor(): number {
  return envInt('FW_WATCH_MIN_REQUESTS', 'the volume floor for profiling');
}

/** Hours of history a screen reads. */
export function watchHours(): number {
  return envInt('FW_WATCH_HOURS', 'the screening window');
}

/** How often the TUI re-screens. */
export function watchIntervalMs(): number {
  return envInt('FW_WATCH_INTERVAL_MIN', 'minutes between screens') * 60_000;
}
