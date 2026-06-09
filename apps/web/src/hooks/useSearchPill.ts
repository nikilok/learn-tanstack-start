import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { useSearchShortcut } from './useSearchShortcut';

/**
 * Remove the `data-hide-search-input` attribute set by the pre-hydration
 * inline script, handing first-paint control back to React. No-op on server.
 */
function clearHideAttribute() {
  if (typeof document === 'undefined') return;
  document.documentElement.removeAttribute('data-hide-search-input');
}

/**
 * Drive the sticky search-pill state machine. Observes a sentinel to detect
 * when the input has scrolled off, debounces the un-stick transition to
 * avoid blinking during content reflow, clears the pre-hydration hide
 * attribute safely, and wires `/`, `⌘K`, and printable keys to activate
 * pill mode only once stuck. Returns `{ isStuck, ready, pillClicked,
 * onPillClick, onPillDismiss }`.
 */
export function useSearchPill(
  inputRef: RefObject<HTMLInputElement | null>,
  sentinelRef: RefObject<HTMLDivElement | null>,
) {
  const [isStuck, setIsStuck] = useState(false);
  // Starts true because the pre-hydration inline script in <head> (see
  // search-input-init.ts) hides the input via a CSS attribute on <html> when
  // the page loads scrolled. React state can safely assume "visible" on first
  // paint; the observer below removes the attribute once it has confirmed the
  // real sentinel position, handing control back to React.
  const [ready, setReady] = useState(true);
  const [pillClicked, setPillClicked] = useState(false);
  const pillClickedRef = useRef(false);
  const isStuckRef = useRef(false);

  useEffect(() => {
    pillClickedRef.current = pillClicked;

    // When pill mode ends, re-sync isStuck with actual sentinel visibility
    if (!pillClicked) {
      const sentinel = sentinelRef.current;
      if (sentinel) {
        const rect = sentinel.getBoundingClientRect();
        setIsStuck(rect.bottom < 0);
      }
    }
  }, [pillClicked, sentinelRef]);

  const unstickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Use the last entry — fast scrolling can batch multiple threshold
        // crossings into a single callback; only the final one is current.
        const entry = entries[entries.length - 1];
        setReady(true);

        if (!entry.isIntersecting) {
          // Sentinel left viewport — stick immediately
          if (unstickTimerRef.current) {
            clearTimeout(unstickTimerRef.current);
            unstickTimerRef.current = null;
          }
          setIsStuck(true);
          isStuckRef.current = true;
        } else {
          // Sentinel re-entered viewport — defer the reset to filter out
          // transient reflows (results reloading can briefly shrink the page,
          // pulling the sentinel back into view before new content pushes it
          // out again). Without this, isStuck toggles rapidly → the input
          // blinks between visible and pill mode on iOS Safari.
          if (unstickTimerRef.current) clearTimeout(unstickTimerRef.current);
          unstickTimerRef.current = setTimeout(() => {
            setIsStuck(false);
            isStuckRef.current = false;
            setPillClicked(false);
            unstickTimerRef.current = null;
          }, 150);
        }
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      if (unstickTimerRef.current) clearTimeout(unstickTimerRef.current);
    };
  }, [sentinelRef]);

  // Primary cleanup: once React has rendered pill mode (isStuck=true), the
  // input's own inline opacity:0 handles hiding. The pre-hydration CSS
  // attribute is now redundant and can be cleared.
  useLayoutEffect(() => {
    if (isStuck) clearHideAttribute();
  }, [isStuck]);

  // Safety net: drop the attribute once the restore is done UNLESS we've landed
  // in pill mode. Polls every animation frame and terminates when one of:
  //   1. The attribute was removed by another path (e.g. `isStuck=true` above).
  //   2. `hmrc-scroll-y` is consumed AND the sentinel is in view (not pill) — so
  //      the input is the correct final state and we clear.
  //   3. The component unmounts (cancelled flag stops the next tick).
  //
  // We can't gate on `scrollY === 0`: a small or clamped restore (the rAF can
  // race the virtual list's height and settle at a few px) leaves the sentinel
  // in view — input mode, not pill — where `isStuck` never goes true and the old
  // `scrollY === 0` guard never matched, stranding the input hidden. Reading the
  // sentinel only after the key is gone keeps the rect post-restore and accurate
  // (not the pre-restore lie warned about elsewhere). If the sentinel is scrolled
  // out we leave the attribute for the `isStuck` useLayoutEffect, so the input
  // never flashes at a scrolled position.
  //
  // A naive timeout cutoff isn't safe — HmrcResults' scroll-restore is gated on
  // the virtualizer's font/width readiness, which can take an indefinite number
  // of frames on slow loads. rAF auto-pauses on background tabs, so an open-ended
  // poll has no idle cost when the user isn't looking.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!document.documentElement.hasAttribute('data-hide-search-input')) {
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (!document.documentElement.hasAttribute('data-hide-search-input')) {
        return;
      }
      if (!sessionStorage.getItem('hmrc-scroll-y')) {
        const sentinel = sentinelRef.current;
        const stuck = sentinel
          ? sentinel.getBoundingClientRect().bottom < 0
          : false;
        if (!stuck) {
          clearHideAttribute();
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [sentinelRef]);

  // Only activate pill mode when scrolled past the sentinel
  useSearchShortcut(inputRef, () => {
    if (isStuckRef.current) setPillClicked(true);
  });

  return {
    isStuck,
    ready,
    pillClicked,
    onPillClick: () => setPillClicked(true),
    onPillDismiss: () => setPillClicked(false),
  };
}
