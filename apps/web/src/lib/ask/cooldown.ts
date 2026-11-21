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

/** The wait to keep when a call names one: the later of the one already known and the one told, as more than one total can be waiting. */
export function laterCooldown(known: number | null, told: number): number {
  return known === null ? told : Math.max(known, told);
}

/** How long a wait the server names is held at the least. */
const TOLD_WAIT_MIN_MS = 60 * 1000;

/**
 * A wait the server named, as this device holds it: the time told, or a
 * short while from now where this device's clock says that time has passed.
 * The server's clock is the one that counts, so a wait just told is never
 * over, and asking is not tried again at once.
 */
export function toldCooldown(told: number, now: number): number {
  return told > now ? told : now + TOLD_WAIT_MIN_MS;
}

/** The wait to show when a call names one: the latest of the one shown, the one kept for the device and the one told. */
export function latestCooldown(
  shown: number | null,
  stored: number | null,
  told: number,
): number {
  return laterCooldown(shown, laterCooldown(stored, told));
}

/** The wait still to keep once one has ended: a later one stored since, as another tab may have been told one; null when none is ahead. */
export function waitAfter(ended: number, stored: number | null): number | null {
  return stored !== null && stored > ended ? stored : null;
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

/** Keeps a wait for the device unless a later one is kept already, as another tab may have been told one. Never throws. */
export function keepCooldown(until: number, now = Date.now()): void {
  saveCooldown(laterCooldown(loadCooldown(now), until));
}

/**
 * What a document does when the wait kept for the device changes under it,
 * as another tab keeps or forgets one: the wait to show, and one to put back
 * where this document shows a later one still ahead (null where there is
 * none). The owner's document waits out no time, so nothing changes for it.
 */
export function heardCooldown({
  owner,
  shown,
  stored,
  now,
}: {
  owner: boolean;
  shown: number | null;
  stored: number | null;
  now: number;
}): { show: number | null; keep: number | null } {
  if (owner) return { show: shown, keep: null };
  const ahead = shown !== null && shown > now ? shown : null;
  if (stored !== null && (ahead === null || stored >= ahead))
    return { show: stored, keep: null };
  return { show: shown, keep: ahead };
}

/** Calls `heard` each time another tab keeps or forgets the device's wait, and returns how to stop. With no window there is nothing to hear. */
export function onCooldownKept(heard: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: StorageEvent) => {
    // A null key is the whole store cleared.
    if (event.key === null || event.key === STORE_KEY) heard();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
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
  return `That’s the limit for questions for now. You can ask again after ${askAgainWhen(until, when)}.`;
}

/** What the end of a question's listing says while the rest of its answer waits on a cooldown. */
export function cooldownHold(until: number, when: When = {}): string {
  return `That’s the limit for questions for now. More matches can load after ${askAgainWhen(until, when)}.`;
}
