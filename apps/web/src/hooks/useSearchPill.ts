import { type RefObject, useEffect, useRef, useState } from 'react';
import { useSearchShortcut } from './useSearchShortcut';

export function useSearchPill(
  inputRef: RefObject<HTMLInputElement | null>,
  sentinelRef: RefObject<HTMLDivElement | null>,
) {
  const [isStuck, setIsStuck] = useState(false);
  const [ready, setReady] = useState(false);
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
