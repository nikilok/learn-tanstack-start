import { useEffect, useState } from 'react';

import {
  ACTIVITY_EVENTS,
  IDLE_TIMEOUT_MS,
  isWakeMove,
  type PointerPoint,
  remainingIdleMs,
} from '../lib/screensaver/idle';
import { isDesktopPreview } from '../utils/desktop-preview';

/**
 * Whether the user has gone quiet for `timeoutMs` — no pointer movement, clicks, keys
 * or wheel. Client-only: it starts false so SSR and hydration agree, and only effects
 * ever read the DOM. Once idle, the same events end it, except that pointer movement
 * must cover a real distance so a drifting mouse can't dismiss the screensaver alone.
 */
export function useIdle(timeoutMs: number = IDLE_TIMEOUT_MS): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    // The /download preview iframes are inert — they receive no input at all, so they
    // would go idle immediately and run a screensaver inside the demo window.
    if (isDesktopPreview()) return;

    let lastActivityAt = performance.now();
    let pointer: PointerPoint | null = null;
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
          if (isWakeMove(origin, pointer)) wake();
          return;
        }
      } else if (isIdle) {
        wake();
        return;
      }
      // The hot path (every pointermove) is one timestamp write, never timer churn —
      // `check` re-arms itself for the remainder instead. `timeStamp` is already on the
      // event and shares performance.now()'s clock; synthetic events may report 0.
      lastActivityAt = event.timeStamp || performance.now();
    };

    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, {
        capture: true,
        passive: true,
      });
    }
    arm(timeoutMs);

    return () => {
      window.clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
    };
  }, [timeoutMs]);

  return idle;
}
