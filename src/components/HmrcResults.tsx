import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type HmrcRow, searchHmrc } from '../api/hmrc';
import HmrcCard from './HmrcCard';
import SkeletonCards from './SkeletonCards';

export default function HmrcResults({ search }: { search: string }) {
  const [results, setResults] = useState<HmrcRow[]>([]);
  const [loading, setLoading] = useState(search.length >= 3);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    if (search.length < 3) {
      setResults([]);
      setHasMore(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timeout = setTimeout(async () => {
      try {
        const data = await searchHmrc({ data: { query: search, offset: 0 } });
        if (searchRef.current === search) {
          setResults(data.rows);
          setHasMore(data.hasMore);
        }
      } finally {
        if (searchRef.current === search) setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [search]);

  const fetchMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await searchHmrc({
        data: { query: searchRef.current, offset: results.length },
      });
      if (searchRef.current === search) {
        setResults((prev) => [...prev, ...data.rows]);
        setHasMore(data.hasMore);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, results.length, search]);

  const virtualizer = useWindowVirtualizer({
    count: results.length,
    estimateSize: () => 120,
    gap: 12,
    overscan: 5,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();

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

  if (loading) return <SkeletonCards />;

  if (results.length === 0 && search.length >= 3) {
    return (
      <p className="mt-6 text-sm text-(--sea-ink-soft)">
        No organisations found matching &ldquo;{search}&rdquo;
      </p>
    );
  }

  if (results.length === 0) return null;

  return (
    <div ref={listRef} className="mt-6">
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
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            <HmrcCard row={results[virtualRow.index]} />
          </div>
        ))}
      </div>
      {loadingMore && <SkeletonCards count={3} />}
    </div>
  );
}
