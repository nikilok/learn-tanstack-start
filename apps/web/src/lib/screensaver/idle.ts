// Idleness rules for the screensaver. Kept apart from the DOM wiring in hooks/useIdle.ts
// so the timing and the wake threshold are testable without a browser.

/**
 * How long the user must be quiet — no pointer movement, clicks, keys or wheel — before
 * the screensaver takes over a browser tab. Reading a page generates no input at all, so
 * this has to sit well clear of how long someone spends working through a company's
 * licences, address and timeline, or the screensaver interrupts its most engaged reader.
 */
export const IDLE_TIMEOUT_MS = 3 * 60_000;

/** The same, in the desktop shell — a window parked on a second monitor is idle in a way a tab being read never is, so it can settle much sooner. */
export const DESKTOP_IDLE_TIMEOUT_MS = 60_000;

/** The idle threshold for the surface the app is running on. */
export function idleTimeoutFor(desktopShell: boolean): number {
  return desktopShell ? DESKTOP_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
}

/**
 * Event other surfaces dispatch on `window` to count as user activity. The Electron
 * shell's title bar is a separate WebContentsView, so input there never reaches this
 * document — main forwards it and the bridge re-emits it here.
 */
export const EXTERNAL_ACTIVITY_EVENT = 'ss:activity';

/**
 * What counts as the user being present. Pointer events cover mouse, pen and touch;
 * `scroll` is deliberately absent — it also fires for programmatic scrolls (the
 * back-nav scroll restore), which would keep resetting the timer on their own.
 */
export const ACTIVITY_EVENTS = [
  'pointermove',
  'pointerdown',
  'keydown',
  'wheel',
  EXTERNAL_ACTIVITY_EVENT,
] as const;

/** How far the pointer must travel from where it rested before that counts as waking the screensaver. */
export const WAKE_MOVE_PX = 6;

export interface PointerPoint {
  x: number;
  y: number;
}

/** Milliseconds left before `lastActivityAt` counts as idle — 0 once it does. */
export function remainingIdleMs(
  lastActivityAt: number,
  now: number,
  timeoutMs: number = IDLE_TIMEOUT_MS,
): number {
  return Math.max(0, lastActivityAt + timeoutMs - now);
}

/**
 * Whether a pointer position is a real wake gesture rather than drift, measured against
 * where the pointer sat when the screensaver took over. A null origin means the pointer
 * has never moved in this document, so any movement at all counts.
 */
export function isWakeMove(
  origin: PointerPoint | null,
  to: PointerPoint,
  threshold: number = WAKE_MOVE_PX,
): boolean {
  if (!origin) return true;
  return Math.hypot(to.x - origin.x, to.y - origin.y) >= threshold;
}
