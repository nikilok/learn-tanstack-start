import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSearchShortcut } from './useSearchShortcut';

function clearHideAttribute() {
  if (typeof document === 'undefined') return;
  document.documentElement.removeAttribute('data-hide-search-input');
}

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

  // Safety net: if the inline script set the attribute but we end up at the
  // top of the page with nothing to restore (rare — e.g., the script fired
  // during a transient scroll that was then reset), remove it after two
  // animation frames. HmrcResults' scroll-restore rAF fires in the same
  // window, so by the second frame scroll position reflects reality.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!document.documentElement.hasAttribute('data-hide-search-input')) {
      return;
    }
    let cancelled = false;
    const outer = requestAnimationFrame(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        if (window.scrollY === 0 && !sessionStorage.getItem('hmrc-scroll-y')) {
          clearHideAttribute();
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(outer);
    };
  }, []);

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
