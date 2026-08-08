import { volumeFloor } from './ban-advice';

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

/**
 * Requests a fingerprint needs before it is worth profiling, scaled to the window.
 *
 * The env value is a RATE PER DAY, not an absolute count. It used to be absolute while the
 * advisory's own `volumeFloor` scaled, so the two disagreed by the window length: over 6 days the
 * screen demanded 6x what the advisory needed, and nothing was ever profiled. The disagreement,
 * not either number, was the defect.
 *
 * Never below `volumeFloor` for the same window: profiling an identity the advisory cannot reach
 * a verdict on spends ~21 queries to produce "not enough traffic to say". Above it is a
 * legitimate operator choice — profile less, spend less.
 */
export function screenFloor(windowMinutes = 1440): number {
  const perDay = envInt(
    'FW_WATCH_MIN_REQUESTS',
    'the profiling floor as a rate PER DAY, scaled to the window',
  );
  const scaled = Math.round((perDay * windowMinutes) / 1440);
  return Math.max(volumeFloor(windowMinutes), scaled);
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

/**
 * The watch window as a display string, or null when it is not configured.
 *
 * The readers above throw by design — a missing threshold must not silently become a default.
 * But the TUI calls them during render, where a throw takes down the whole session including
 * staged denies, so it needs to ask the question without being punished for the answer.
 */
export function watchTiming(): string | null {
  try {
    return `${watchHours()}h window, every ${watchIntervalMs() / 60_000}m`;
  } catch {
    return null;
  }
}

/**
 * The allowlist, or undefined when it cannot be read.
 *
 * Every caller wants this shape — `undefined` means "not known", which the advisory treats as
 * "exempt every verified crawler", the safe direction. Shared so the try/catch is written once:
 * three call sites had their own, and the interactive one simply forgot to pass the result.
 */
export function allowedBotsOrUnknown(): {
  names?: string[];
  error?: string;
} {
  try {
    return { names: allowedBots() };
  } catch (e) {
    // Returned, never swallowed. An unreadable allowlist exempts EVERY verified crawler, which
    // is the safe direction but a large silent change in what the tool will recommend — and a
    // failure that degrades to a value with no signal is this codebase's oldest defect class.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
