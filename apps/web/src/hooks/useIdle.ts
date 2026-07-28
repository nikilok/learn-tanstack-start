import { useEffect, useState } from 'react';

import {
  ACTIVITY_EVENTS,
  EXTERNAL_ACTIVITY_EVENT,
  idleTimeoutFor,
  isDeliberateInput,
  isWakeMove,
  type PointerPoint,
  remainingIdleMs,
  SWALLOW_ON_WAKE,
} from '../lib/screensaver/idle';
import { isDesktopPreview } from '../utils/desktop-preview';

/**
 * True while the screensaver holds the window. Other global key handlers must bail out on
 * it: the keystroke that dismisses the screensaver must not also reach the app. Reads the
 * attribute ScreenSaver stamps on `<html>` for its own CSS, so there is no second source
 * of truth — and handlers registered before ours (window capture, registration order) can
 * consult it, which `stopImmediatePropagation` alone cannot reach.
 */
export function screenSaverHoldsWindow(): boolean {
  return document.documentElement.dataset['screensaver'] === 'on';
}

/**
 * Whether the user has gone quiet — no pointer movement, clicks, keys or wheel — for
 * long enough that the screensaver should take over, which is sooner in the desktop
 * shell than in a browser tab. Client-only: it starts false so SSR and hydration agree,
 * and only effects ever read the DOM. Once idle, the same events end it, except that
 * pointer movement must cover a real distance so a drifting mouse can't end it alone.
 */
export function useIdle(): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    // The /download preview iframes are inert — they receive no input at all, so they
    // would go idle immediately and run a screensaver inside the demo window.
    if (isDesktopPreview()) return;
    // Touch devices never get one: the handset blanks its own screen, and reading a page
    // without touching it is the normal case there, so it would be near-all false fires.
    // Mirrors the gate CustomCursor uses; `fine` also excludes `pointer: none` surfaces.
    if (!window.matchMedia('(pointer: fine)').matches) return;

    const shell = window.isSponsorSearchDesktop === true;
    // The web app deploys continuously; the shell ships on its own release cadence. A shell
    // that predates the screensaver bridge can neither fade its chrome nor forward input
    // from it, so the coil would run under an opaque title bar that clicking cannot wake.
    // Gate on the capability, not on being desktop, and sit it out until they update.
    if (shell && typeof window.ssDesktop?.setScreenSaver !== 'function') return;
    const timeoutMs = idleTimeoutFor(shell);

    let lastActivityAt = performance.now();
    let pointer: PointerPoint | null = null;
    // Last position that counted as activity. Movement is measured from here, not from the
    // previous event, so a slow real drag still accumulates past the threshold.
    let anchor: PointerPoint | null = null;
    let origin: PointerPoint | null = null; // where the pointer rested when we went idle
    let isIdle = false;
    let timer = 0;

    const arm = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, delay);
    };

    /** Go idle, or — if activity has since moved the deadline — re-arm for what's left. */
    function check() {
      const remaining = remainingIdleMs(
        lastActivityAt,
        performance.now(),
        timeoutMs,
      );
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      isIdle = true;
      origin = pointer;
      setIdle(true);
    }

    const wake = () => {
      isIdle = false;
      lastActivityAt = performance.now();
      setIdle(false);
      arm(timeoutMs);
    };

    const onActivity = (event: Event) => {
      if (event.type === 'pointermove') {
        const move = event as PointerEvent;
        pointer = { x: move.clientX, y: move.clientY };
        if (isIdle) {
          // The first move after going idle only sets the reference: the pointer may not
          // have moved in this document at all (clicks never record a position), and the
          // browser dispatches a move at unchanged coordinates to recompute hover when the
          // overlay appears under a resting cursor. Real movement clears the threshold on
          // the next event a few milliseconds later.
          if (!origin) origin = pointer;
          else if (isWakeMove(origin, pointer)) wake();
          return;
        }
        // The same drift filter applies on the way in: sensor jitter under a resting hand
        // must not hold the countdown open forever, on exactly the hardware the wake path
        // already knows it has to ignore.
        if (anchor && !isWakeMove(anchor, pointer)) return;
        anchor = pointer;
      } else if (isIdle) {
        // Deliberate input only. The shell forwards chrome input through this same path,
        // and a pointer drifting over the title bar must behave like drift over the page.
        if (
          event.type === EXTERNAL_ACTIVITY_EVENT &&
          !isDeliberateInput((event as CustomEvent).detail)
        ) {
          lastActivityAt = event.timeStamp || performance.now();
          return;
        }
        // Swallow the gesture that woke it: it belongs to the screensaver, not to the app
        // underneath. Capture phase beats every bubble-phase handler in the app.
        if (SWALLOW_ON_WAKE.has(event.type)) {
          event.stopImmediatePropagation();
          if (event.cancelable) event.preventDefault();
        }
        wake();
        return;
      }
      // The hot path (every pointermove) is one timestamp write, never timer churn —
      // `check` re-arms itself for the remainder instead. `timeStamp` is already on the
      // event and shares performance.now()'s clock; synthetic events may report 0.
      lastActivityAt = event.timeStamp || performance.now();
    };

    for (const type of ACTIVITY_EVENTS) {
      // keydown non-passive so the waking keystroke can be preventDefault'ed; the rest
      // stay passive, which matters most for pointermove and wheel.
      window.addEventListener(type, onActivity, {
        capture: true,
        passive: type !== 'keydown',
      });
    }
    arm(timeoutMs);

    return () => {
      window.clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
    };
  }, []);

  return idle;
}
