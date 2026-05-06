import type { Virtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * Scroll the page up so the highlighted row sits below the sticky search
 * pill. The virtualizer's scrollToIndex puts the row at viewport top, but the
 * pill overlays the top region — without this nudge the row hides behind it.
 */
function nudgeBelowStickyHeader(index: number) {
  const card = document.querySelector(`[data-index="${index}"]`);
  const pill = document.querySelector('[data-sticky-search]');
  if (!card || !pill) return;
  const cardTop = card.getBoundingClientRect().top;
  const pillBottom = pill.getBoundingClientRect().bottom;
  if (cardTop < pillBottom) {
    window.scrollBy({ top: cardTop - pillBottom });
  }
}

/**
 * Keyboard navigation for the search results list. ArrowDown/ArrowUp move a
 * highlight through the rows (clamped at the ends), Enter activates the
 * highlighted row so TanStack Router's viewTransition click handler runs
 * unchanged. Works whether or not the search input is focused — arrows are
 * consumed globally as long as there are results. Highlight resets when the
 * search query changes so a stale index doesn't carry over to a different
 * result set, and on real pointer movement so the bar is keyboard-only.
 */
export function useResultsKeyboardNav({
  count,
  search,
  virtualizer,
  onActivate,
}: {
  count: number;
  search: string;
  virtualizer: Virtualizer<Window, Element>;
  onActivate: (index: number) => void;
}) {
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const stateRef = useRef({ count, highlightedIndex, virtualizer, onActivate });
  stateRef.current = { count, highlightedIndex, virtualizer, onActivate };

  // biome-ignore lint/correctness/useExhaustiveDependencies: search is the reset trigger
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [search]);

  useEffect(() => {
    if (count === 0) return;
    const handler = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (s.count === 0) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't steal arrow/enter from the IME candidate popup during composition.
      if (e.isComposing) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next =
          s.highlightedIndex < 0
            ? 0
            : Math.min(s.highlightedIndex + 1, s.count - 1);
        // flushSync commits the highlight DOM update before the synchronous
        // scroll, otherwise the browser paints one frame with the new scroll
        // position but the old highlight class.
        flushSync(() => setHighlightedIndex(next));
        s.virtualizer.scrollToIndex(next);
        nudgeBelowStickyHeader(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = s.highlightedIndex <= 0 ? 0 : s.highlightedIndex - 1;
        flushSync(() => setHighlightedIndex(next));
        // At the top, scroll past the list to reveal the search input above it.
        if (next === 0) {
          window.scrollTo({ top: 0 });
        } else {
          s.virtualizer.scrollToIndex(next);
          nudgeBelowStickyHeader(next);
        }
      } else if (e.key === 'Enter' && s.highlightedIndex >= 0) {
        e.preventDefault();
        s.onActivate(s.highlightedIndex);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [count]);

  // Coord-delta filter: Safari fires synthetic mousemove during programmatic
  // scroll to update :hover, with the same clientX/Y. Ignore those.
  useEffect(() => {
    let lastX: number | null = null;
    let lastY: number | null = null;
    const handler = (e: MouseEvent) => {
      if (e.clientX === lastX && e.clientY === lastY) return;
      const initialized = lastX !== null;
      lastX = e.clientX;
      lastY = e.clientY;
      if (initialized && stateRef.current.highlightedIndex >= 0) {
        setHighlightedIndex(-1);
      }
    };
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return highlightedIndex;
}
