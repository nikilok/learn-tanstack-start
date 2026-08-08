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

/**
 * Verified crawlers we actually want, lower-cased. Everything else stays a candidate however
 * Vercel classified it.
 *
 * Verification proves a crawler is who it says — not that we want it reading the whole corpus.
 * Treating every `botVerified: pass` as legitimate hands the same access to commercial SEO and
 * AI harvesters, which is the outcome this list exists to prevent.
 *
 * Required, and it throws when absent rather than defaulting to "allow all": a silent fallback
 * would restore exactly the behaviour being narrowed, and it would do it invisibly. Callers read
 * this at their boundary so the failure surfaces as an error, never mid-advisory.
 */
export function allowedBots(): string[] {
  const raw = process.env.FW_ALLOWED_BOTS?.trim();
  const names = (raw ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (!names.length)
    throw new Error(
      'FW_ALLOWED_BOTS must list the verified crawlers to exempt, comma-separated, in .env.local — everything else stays bannable',
    );
  return names;
}
