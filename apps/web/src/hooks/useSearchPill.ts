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

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Use the last entry — fast scrolling can batch multiple threshold
        // crossings into a single callback; only the final one is current.
        const entry = entries[entries.length - 1];
        setReady(true);
        const stuck = !entry.isIntersecting;
        setIsStuck(stuck);
        isStuckRef.current = stuck;
        if (entry.isIntersecting) setPillClicked(false);
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
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
