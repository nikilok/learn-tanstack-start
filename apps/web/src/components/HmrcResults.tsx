import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useVirtualTextLayout } from 'virtual-text-layout';
import { useHmrcSearch } from '../hooks/useHmrcSearch';
import { titleCase } from '../utils';
import HmrcCard from './HmrcCard';
import SkeletonCards from './SkeletonCards';

/**
 * Virtualized list of HMRC sponsor rows for the given search query. Gates
 * rendering on data/fonts/width readiness (canvas-based height estimation via
 * `virtual-text-layout`) to avoid layout shift, triggers infinite-scroll fetches
 * near the end of the window, and wires up sessionStorage scroll restoration.
 * Returns `null` for empty input, a hint for short queries, skeletons while
 * loading, and a "no matches" message when the query yields zero rows.
 */
export default function HmrcResults({ search }: { search: string }) {
  const { results, isLoading, hasMore, loadingMore, fetchMore } =
    useHmrcSearch(search);
  const listRef = useRef<HTMLDivElement>(null);
  // `activeId` only gets set when the user clicks a card on this very
  // mount (via flushSync below). On a remount after back-nav we leave it
  // null on purpose — that way the listing's matching card does *not*
  // receive `view-transition-name: active-card`, so the browser won't
  // pair it with the details wrapper and morph back. Back-nav uses a
  // page-level slide instead (see styles.css).
  const [activeId, setActiveId] = useState<string | null>(null);
  const { estimateSize, ready, contentWidth } = useVirtualTextLayout(results, {
    fields: [
      {
        getText: (row) => titleCase(row.organisationName),
        font: '600 16px Geist', // heading-card h3: text-base + font-semibold
        lineHeight: 24,
        letterSpacing: -0.4, // heading-card utility
      },
      {
        getText: (row) =>
          [row.townCity, row.county].filter(Boolean).map(titleCase).join(', '),
        font: '14px Geist', // text-sm
        lineHeight: 20,
      },
    ],
    fixedHeight: 62, // py-2(8) + mt-0.5(2) + rating(20) + mt-0.5(2) + mt-0.5(2) + route(16) + py-2(8) + 4 (sub-pixel rounding)
    containerRef: listRef,
  });

  const virtualizer = useWindowVirtualizer({
    count: ready ? results.length : 0,
    estimateSize,
    gap: 24,
    overscan: 5,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  useEffect(() => {
    if (contentWidth > 0) virtualizer.measure();
  }, [contentWidth, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (!ready) return;
    const savedY = sessionStorage.getItem('hmrc-scroll-y');
    if (savedY) {
      // Scroll first, then clear the key — in that order, atomically inside
      // a single rAF. If we cleared the key before the rAF fired, there
      // would be a one-frame window where `scrollY === 0` AND the key is
      // gone, which `useSearchPill`'s safety-net poll reads as "nothing to
      // restore" and clears `data-hide-search-input` prematurely. That would
      // briefly unhide the input on a scrolled back-nav restore.
      requestAnimationFrame(() => {
        window.scrollTo(0, Number.parseInt(savedY, 10));
        sessionStorage.removeItem('hmrc-scroll-y');
      });
    }
  }, [ready]);

  useEffect(() => {
    const lastItem = virtualItems[virtualItems.length - 1];
    if (!lastItem) return;
    if (lastItem.index >= results.length - 10 && hasMore && !loadingMore) {
      fetchMore();
    }
  }, [virtualItems, results.length, hasMore, loadingMore, fetchMore]);

  // Save scroll position on pagehide so the pre-hydration script in <head> can
  // hide the input on the next load. Only registered when there are results to
  // scroll past — otherwise iOS keyboard auto-scroll on input focus would write
  // a meaningless value that nothing consumes, leaving the input hidden.
  useEffect(() => {
    if (results.length === 0) return;
    const onPageHide = () => {
      if (window.scrollY > 0) {
        sessionStorage.setItem('hmrc-scroll-y', String(window.scrollY));
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [results.length]);

  if (search.length === 0) return null;

  if (search.length < 3) {
    return (
      <p className="mt-4 text-sm text-(--sea-ink-soft)">
        Type at least 3 characters to search...
      </p>
    );
  }

  if (isLoading || !ready) {
    return (
      <>
        <SkeletonCards />
        {/* Hidden element for width measurement — same px-4 as the real container */}
        <div
          ref={listRef}
          className="px-4"
          style={{ height: 0, overflow: 'hidden' }}
        />
      </>
    );
  }

  if (results.length === 0 && search.length >= 3) {
    return (
      <p className="mt-6 text-sm text-(--sea-ink-soft)">
        No organisations found matching &ldquo;{search}&rdquo;
      </p>
    );
  }

  if (results.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="mt-6 rounded-lg bg-(--sponsor-card-bg) shadow-(--shadow-card) px-4 py-2"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => (
          <div
            key={virtualRow.index}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            <HmrcCard
              row={results[virtualRow.index]}
              search={search}
              isActive={activeId === results[virtualRow.index].slugId}
              onActivate={() => {
                // flushSync forces React to commit the state update before
                // TanStack Router's click handler triggers
                // startViewTransition — otherwise the OLD snapshot would be
                // captured before the active card has its name applied.
                flushSync(() => {
                  setActiveId(results[virtualRow.index].slugId);
                });
              }}
            />
          </div>
        ))}
      </div>
      {loadingMore && <SkeletonCards count={3} bare />}
    </div>
  );
}
