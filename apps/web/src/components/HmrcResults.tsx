import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';
import { useCardMetrics } from '../hooks/useCardMetrics';
import { useHmrcSearch } from '../hooks/useHmrcSearch';
import { titleCase } from '../utils';
import HmrcCard from './HmrcCard';
import SkeletonCards from './SkeletonCards';

/** Content width from known CSS layout: page-wrap(vw-32) - main px-4(32) - container px-4(32) capped by max-w-2xl(672) */
function getContentWidth() {
  return Math.min(document.documentElement.clientWidth - 96, 640);
}

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

  // Compute content width from viewport — no DOM element needed.
  // Recalculates on resize/orientation change.
  useEffect(() => {
    setContentWidth(getContentWidth());
    const onResize = () => setContentWidth(getContentWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const ready = metricsReady && contentWidth > 0;

  const virtualizer = useWindowVirtualizer({
    count: ready ? results.length : 0,
    estimateSize: (index) => estimateCardHeight(index, contentWidth),
    gap: 24,
    overscan: 5,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();

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

  if (isLoading || (results.length > 0 && !ready)) return <SkeletonCards />;

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
