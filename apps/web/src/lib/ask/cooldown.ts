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

/** The calendar day a time falls on in a zone, as a count of days. */
function dayOf(time: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(time);
  return Math.round(Date.parse(parts) / 86_400_000);
}

/**
 * When asking opens again, as a visitor reads it: the clock time in their own
 * locale and zone, and which day that is ("14:05 tomorrow").
 */
export function askAgainWhen(
  until: number,
  now: number,
  { locale, timeZone }: { locale?: string; timeZone?: string } = {},
): string {
  const time = new Intl.DateTimeFormat(locale, {
    timeStyle: 'short',
    timeZone,
  }).format(until);
  const days = dayOf(until, timeZone) - dayOf(now, timeZone);
  if (days <= 0) return `${time} today`;
  if (days === 1) return `${time} tomorrow`;
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    timeZone,
  }).format(until);
  return `${time} on ${weekday}`;
}

type When = { locale?: string; timeZone?: string };

/** What a visitor is told where an ask would have gone, while their device waits out a cooldown. */
export function cooldownNotice(
  until: number,
  now = Date.now(),
  when: When = {},
): string {
  return `You’ve reached the limit for questions for now. You can ask again after ${askAgainWhen(until, now, when)}.`;
}

/** What the end of a question's listing says while the rest of its answer waits on a cooldown. */
export function cooldownHold(
  until: number,
  now = Date.now(),
  when: When = {},
): string {
  return `You’ve reached the limit for questions for now. More matches can load after ${askAgainWhen(until, now, when)}.`;
}
