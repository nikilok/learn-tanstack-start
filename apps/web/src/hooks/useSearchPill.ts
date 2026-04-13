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
      ([entry]) => {
        setReady(true);
        if (!pillClickedRef.current) {
          setIsStuck(!entry.isIntersecting);
        }
        if (entry.isIntersecting && !pillClickedRef.current)
          setPillClicked(false);
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelRef]);

  useSearchShortcut(inputRef, () => setPillClicked(true));

  return {
    isStuck,
    ready,
    pillClicked,
    onPillClick: () => setPillClicked(true),
    onPillDismiss: () => setPillClicked(false),
  };
}
