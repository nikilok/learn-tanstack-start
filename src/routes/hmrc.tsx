import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { desc, sql } from 'drizzle-orm';
import { useCallback, useEffect, useRef, useState } from 'react';
import RatingIcon from '../components/RatingIcon';
import SearchBar from '../components/SearchBar';
import SkeletonCards from '../components/SkeletonCards';
import Tooltip from '../components/Tooltip';
import { db } from '../db';
import { hmrcSkilledWorkers } from '../db/schema';

const PAGE_SIZE = 50;

function titleCase(str: string | null) {
  if (!str) return '';
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const searchHmrc = createServerFn()
  .inputValidator(
    (input: unknown) => input as { query: string; offset: number },
  )
  .handler(async ({ data: { query, offset } }) => {
    if (query.length < 3) return { rows: [], hasMore: false };
    console.log(`[HMRC Search] query="${query}" offset=${offset}`);
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const rows = await db
      .select({
        id: hmrcSkilledWorkers.id,
        organisationName: hmrcSkilledWorkers.organisationName,
        townCity: hmrcSkilledWorkers.townCity,
        county: hmrcSkilledWorkers.county,
        typeRating: hmrcSkilledWorkers.typeRating,
        route: hmrcSkilledWorkers.route,
        score: sql<number>`
          CASE WHEN ${hmrcSkilledWorkers.organisationName} ILIKE ${`%${escaped}%`}
            THEN 1.0 + word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
            ELSE word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
          END`,
      })
      .from(hmrcSkilledWorkers)
      .where(
        sql`(
          ${hmrcSkilledWorkers.organisationName} ILIKE ${`%${escaped}%`}
          OR word_similarity(${query}, ${hmrcSkilledWorkers.organisationName}) > 0.6
        )`,
      )
      .orderBy(
        desc(sql`
          CASE WHEN ${hmrcSkilledWorkers.organisationName} ILIKE ${`%${escaped}%`}
            THEN 1.0 + word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
            ELSE word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
          END`),
      )
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    const hasMore = rows.length > PAGE_SIZE;
    return { rows: rows.slice(0, PAGE_SIZE), hasMore };
  });

type HmrcRow = Awaited<ReturnType<typeof searchHmrc>>['rows'][number];

export const Route = createFileRoute('/hmrc')({
  validateSearch: (search: Record<string, unknown>) => ({
    search: (search.search as string) || '',
  }),
  component: Hmrc,
});

function Hmrc() {
  const { search } = Route.useSearch();
  const navigate = useNavigate();
  const [results, setResults] = useState<HmrcRow[]>([]);
  const [loading, setLoading] = useState(search.length >= 3);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isStuck, setIsStuck] = useState(false);
  const [pillClicked, setPillClicked] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsStuck(!entry.isIntersecting);
        if (entry.isIntersecting) setPillClicked(false);
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

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

  return (
    <main className="page-wrap px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">HMRC</p>
        <div ref={sentinelRef} className="mt-6" />
        <div className="sticky top-24 z-40 -mx-4 px-4 pb-4">
          <SearchBar
            search={search}
            isStuck={isStuck}
            pillClicked={pillClicked}
            onSearch={(value) => {
              if (navTimerRef.current) clearTimeout(navTimerRef.current);
              navTimerRef.current = setTimeout(() => {
                navigate({
                  to: '/hmrc',
                  search: { search: value },
                  replace: true,
                });
              }, 150);
            }}
            onPillClick={() => setPillClicked(true)}
            onBlur={() => setPillClicked(false)}
          />
        </div>

        {search.length > 0 && search.length < 3 && (
          <p className="mt-4 text-sm text-(--sea-ink-soft)">
            Type at least 3 characters to search...
          </p>
        )}

        {loading && <SkeletonCards />}

        {!loading && results.length > 0 && (
          <div ref={listRef} className="mt-6">
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualRow) => {
                const r = results[virtualRow.index];
                return (
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
                    <div className="glass rounded-lg p-4">
                      <Tooltip text={titleCase(r.organisationName)}>
                        <h3 className="heading-card cursor-pointer truncate text-base font-semibold text-(--sea-ink)">
                          {titleCase(r.organisationName)}
                        </h3>
                      </Tooltip>
                      <div className="mt-1 flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <Tooltip
                            text={[r.townCity, r.county]
                              .filter(Boolean)
                              .map(titleCase)
                              .join(', ')}
                          >
                            <p className="cursor-pointer truncate text-sm text-(--sea-ink-soft)">
                              {[r.townCity, r.county]
                                .filter(Boolean)
                                .map(titleCase)
                                .join(', ')}
                            </p>
                          </Tooltip>
                          <Tooltip text={titleCase(r.route)}>
                            <p className="mt-1 cursor-pointer truncate text-xs text-(--sea-ink-soft)">
                              {titleCase(r.route)}
                            </p>
                          </Tooltip>
                        </div>
                        <div className="shrink-0">
                          <RatingIcon rating={r.typeRating} />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {loadingMore && <SkeletonCards count={3} />}
          </div>
        )}

        {!loading && search.length >= 3 && results.length === 0 && (
          <p className="mt-6 text-sm text-(--sea-ink-soft)">
            No organisations found matching &ldquo;{search}&rdquo;
          </p>
        )}
      </section>
    </main>
  );
}
