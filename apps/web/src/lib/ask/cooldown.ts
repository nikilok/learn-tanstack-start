// A device whose asks have used up its token budget waits out a cooldown,
// which the server decides on every request (lib/ask/allowance.server). This
// is the browser's side: the time asking opens again, kept for the device so a
// later visit knows it at mount and spares a refused call, and how that time
// is said.

/** How long a window of asks runs, and how long a device waits once its asks have used up its budget in one. */
export const COOLDOWN_SECONDS = 24 * 60 * 60;

const COOLDOWN_MS = COOLDOWN_SECONDS * 1000;

const STORE_KEY = 'ss-ask-cooldown';

/**
 * A stored time asking opens again, when it still holds: a time ahead, and no
 * further ahead than two cooldowns, so a value nobody wrote or a clock put
 * back never closes asking for good. The slack is for a clock that runs
 * behind the server's.
 */
export function storedCooldown(value: unknown, now: number): number | null {
  const until = typeof value === 'string' && value ? Number(value) : null;
  if (until === null || !Number.isFinite(until)) return null;
  return until > now && until - now <= 2 * COOLDOWN_MS ? until : null;
}

/** The time this device may ask again, as last told; null when it is not waiting. Never throws: no storage, no cooldown known. */
export function loadCooldown(now = Date.now()): number | null {
  try {
    return storedCooldown(localStorage.getItem(STORE_KEY), now);
  } catch {
    return null;
  }
}

/** Keeps the time the server said this device may ask again. Never throws. */
export function saveCooldown(until: number): void {
  try {
    localStorage.setItem(STORE_KEY, String(until));
  } catch {
    // No storage: the server says so again on the next ask.
  }
}

/** Forgets the cooldown, once it has passed. Never throws. */
export function clearCooldown(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing was kept.
  }
}

type When = { locale?: string; timeZone?: string };

/**
 * When asking opens again, as a visitor reads it: the clock time in their own
 * locale and zone, and the day it falls on there ("14:05 on Sunday"). The day
 * is named, never counted from now, so a page left open still reads true.
 */
export function askAgainWhen(
  until: number,
  { locale, timeZone }: When = {},
): string {
  const time = new Intl.DateTimeFormat(locale, {
    timeStyle: 'short',
    timeZone,
  }).format(until);
  // The sentence around it is English, so its weekday is too.
  const weekday = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    timeZone,
  }).format(until);
  return `${time} on ${weekday}`;
}

/** What a visitor is told where an ask would have gone, while their device waits out a cooldown. */
export function cooldownNotice(until: number, when: When = {}): string {
  return `You’ve reached the limit for questions for now. You can ask again after ${askAgainWhen(until, when)}.`;
}

/** What the end of a question's listing says while the rest of its answer waits on a cooldown. */
export function cooldownHold(until: number, when: When = {}): string {
  return `You’ve reached the limit for questions for now. More matches can load after ${askAgainWhen(until, when)}.`;
}
