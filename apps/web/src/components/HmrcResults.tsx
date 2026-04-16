import { layout, prepare } from '@chenglou/pretext';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';
import { useHmrcSearch } from '../hooks/useHmrcSearch';
import { titleCase } from '../utils';
import HmrcCard from './HmrcCard';
import SkeletonCards from './SkeletonCards';

// Font specs must match the rendered CSS
const HEADING_FONT = '600 16px Geist'; // heading-card h3: text-base + font-semibold
const HEADING_LINE_HEIGHT = 24; // text-base line-height: 1.5 × 16px
const LOCATION_FONT = '14px Geist'; // text-sm, normal weight
const LOCATION_LINE_HEIGHT = 20; // text-sm line-height: 1.25rem
// Fixed card chrome (elements that never wrap):
//   py-2(8) + mt-0.5(2) + rating(20) + mt-0.5(2) + mt-0.5(2) + route(16) + py-2(8)
const CARD_CHROME = 58;

interface CardMetrics {
  heading: ReturnType<typeof prepare>;
  location: ReturnType<typeof prepare>;
}

export default function HmrcResults({ search }: { search: string }) {
  const { results, isLoading, hasMore, loadingMore, fetchMore } =
    useHmrcSearch(search);
  const listRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const cardMetricsRef = useRef<CardMetrics[]>([]);

  // Only prepare newly-loaded rows — avoids re-mapping the full list on every render
  if (results.length < cardMetricsRef.current.length) {
    cardMetricsRef.current = []; // new search — reset
  }
  if (results.length > cardMetricsRef.current.length) {
    cardMetricsRef.current = [
      ...cardMetricsRef.current,
      ...results.slice(cardMetricsRef.current.length).map((row) => ({
        heading: prepare(titleCase(row.organisationName), HEADING_FONT),
        location: prepare(
          [row.townCity, row.county].filter(Boolean).map(titleCase).join(', '),
          LOCATION_FONT,
        ),
      })),
    ];
  }
  const cardMetrics = cardMetricsRef.current;

  const virtualizer = useWindowVirtualizer({
    count: results.length,
    estimateSize: (index) => {
      const m = cardMetrics[index];
      if (!m || !contentWidth) return 100;
      const { height: headingH } = layout(
        m.heading,
        contentWidth,
        HEADING_LINE_HEIGHT,
      );
      const { height: locationH } = layout(
        m.location,
        contentWidth,
        LOCATION_LINE_HEIGHT,
      );
      return headingH + locationH + CARD_CHROME;
    },
    gap: 24,
    overscan: 5,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Track container content width for pretext layout calculations
  const hasResults = results.length > 0;
  useEffect(() => {
    if (!hasResults) return;
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentBoxSize?.[0]?.inlineSize;
      if (width) setContentWidth(Math.floor(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasResults]);

  // Force re-estimation when container width changes
  useEffect(() => {
    if (contentWidth > 0) virtualizer.measure();
  }, [contentWidth, virtualizer]);

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
