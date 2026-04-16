import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCardMetrics } from '../hooks/useCardMetrics';
import { useHmrcSearch } from '../hooks/useHmrcSearch';
import { titleCase } from '../utils';
import HmrcCard from './HmrcCard';
import SkeletonCards from './SkeletonCards';

export default function HmrcResults({ search }: { search: string }) {
  const { results, isLoading, hasMore, loadingMore, fetchMore } =
    useHmrcSearch(search);
  const listRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const { estimateSize: estimateCardHeight, ready: metricsReady } =
    useCardMetrics(results, {
      fields: [
        {
          getText: (row) => titleCase(row.organisationName),
          font: '600 16px Geist', // heading-card h3: text-base + font-semibold
          lineHeight: 24,
        },
        {
          getText: (row) =>
            [row.townCity, row.county]
              .filter(Boolean)
              .map(titleCase)
              .join(', '),
          font: '14px Geist', // text-sm
          lineHeight: 20,
        },
      ],
      fixedHeight: 58, // py-2(8) + mt-0.5(2) + rating(20) + mt-0.5(2) + mt-0.5(2) + route(16) + py-2(8)
    });

  const ready = metricsReady && contentWidth > 0;

  const virtualizer = useWindowVirtualizer({
    count: ready ? results.length : 0,
    estimateSize: (index) => estimateCardHeight(index, contentWidth),
    gap: 24,
    overscan: 5,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Measure content width from a DOM element with matching horizontal padding.
  // Runs before paint via useLayoutEffect — the measurement div is hidden
  // and rendered alongside the skeleton while waiting for readiness.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const paddingX =
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    setContentWidth(Math.floor(el.clientWidth - paddingX));
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentBoxSize?.[0]?.inlineSize;
      if (width) {
        setContentWidth(Math.floor(width));
        virtualizer.measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [virtualizer]);

  useEffect(() => {
    if (!ready) return;
    const savedY = sessionStorage.getItem('hmrc-scroll-y');
    if (savedY) {
      sessionStorage.removeItem('hmrc-scroll-y');
      requestAnimationFrame(() => {
        window.scrollTo(0, Number.parseInt(savedY, 10));
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

  if (search.length > 0 && search.length < 3) {
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
            <HmrcCard row={results[virtualRow.index]} search={search} />
          </div>
        ))}
      </div>
      {loadingMore && <SkeletonCards count={3} bare />}
    </div>
  );
}
