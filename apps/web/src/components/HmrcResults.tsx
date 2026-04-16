import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';
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
  const estimateCardHeight = useCardMetrics(results, {
    fields: [
      {
        getText: (row) => titleCase(row.organisationName),
        font: '600 16px Geist', // heading-card h3: text-base + font-semibold
        lineHeight: 24,
      },
      {
        getText: (row) =>
          [row.townCity, row.county].filter(Boolean).map(titleCase).join(', '),
        font: '14px Geist', // text-sm
        lineHeight: 20,
      },
    ],
    fixedHeight: 58, // py-2(8) + mt-0.5(2) + rating(20) + mt-0.5(2) + mt-0.5(2) + route(16) + py-2(8)
  });

  const virtualizer = useWindowVirtualizer({
    count: results.length,
    estimateSize: (index) => estimateCardHeight(index, contentWidth),
    gap: 24,
    overscan: 5,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Measure container width and invalidate virtualizer sizes — items are gated
  // on contentWidth > 0 in the JSX so nothing renders until sizes are accurate.
  const hasResults = results.length > 0;
  useEffect(() => {
    if (!hasResults) return;
    const el = listRef.current;
    if (!el) return;
    setContentWidth(Math.floor(el.clientWidth));
    virtualizer.measure();
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentBoxSize?.[0]?.inlineSize;
      if (width) {
        setContentWidth(Math.floor(width));
        virtualizer.measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasResults, virtualizer]);

  useEffect(() => {
    const savedY = sessionStorage.getItem('hmrc-scroll-y');
    if (savedY) {
      sessionStorage.removeItem('hmrc-scroll-y');
      requestAnimationFrame(() => {
        window.scrollTo(0, Number.parseInt(savedY, 10));
      });
    }
  }, []);

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

  if (isLoading) return <SkeletonCards />;

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
      {contentWidth > 0 ? (
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
      ) : (
        <SkeletonCards bare />
      )}
      {loadingMore && <SkeletonCards count={3} bare />}
    </div>
  );
}
