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
  // Coming back to a backgrounded tab counts as presence. Without it the countdown runs
  // while the tab is hidden, and since rAF and transitions are frozen there, the user
  // returns to watch the page they left dissolve away in front of them.
  'visibilitychange',
  EXTERNAL_ACTIVITY_EVENT,
] as const;

/**
 * Events whose default action and onward delivery belong to the screensaver rather than
 * the app when they are the gesture that wakes it. Without this the waking keystroke also
 * reaches the app's own global key handlers — typing into the search box, activating the
 * highlighted result, scrolling the page — which is the opposite of dismissing a screen.
 */
export const SWALLOW_ON_WAKE = new Set(['keydown', 'pointerdown', 'wheel']);

/** Whether forwarded shell input was a deliberate gesture rather than the pointer passing over the chrome. Anything without the marker counts as deliberate; only the bridge flags movement. */
export function isDeliberateInput(detail: unknown): boolean {
  return (detail as { deliberate?: boolean } | null)?.deliberate !== false;
}

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
 * Whether the pointer has travelled far enough from a reference point to count as real
 * movement rather than drift. The caller supplies the reference: where the pointer rested
 * when the screensaver took over, or the last position that counted as activity.
 */
export function isWakeMove(
  origin: PointerPoint,
  to: PointerPoint,
  threshold: number = WAKE_MOVE_PX,
): boolean {
  return Math.hypot(to.x - origin.x, to.y - origin.y) >= threshold;
}
