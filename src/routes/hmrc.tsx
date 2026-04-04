import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { asc, ilike } from 'drizzle-orm';
import { useCallback, useEffect, useRef, useState } from 'react';
import SkeletonCards from '../components/SkeletonCards';
import Tooltip from '../components/Tooltip';
import { db } from '../db';
import { hmrcSkilledWorkers } from '../db/schema';

const PAGE_SIZE = 50;

const searchHmrc = createServerFn()
  .inputValidator(
    (input: unknown) => input as { query: string; offset: number },
  )
  .handler(async ({ data: { query, offset } }) => {
    if (query.length < 3) return { rows: [], hasMore: false };
    const rows = await db
      .select()
      .from(hmrcSkilledWorkers)
      .where(ilike(hmrcSkilledWorkers.organisationName, `%${query}%`))
      .orderBy(asc(hmrcSkilledWorkers.organisationName))
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
    estimateSize: () => 100,
    gap: 12,
    overscan: 10,
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
        <div className="sticky top-24 z-40 -mx-4 mt-6 px-4 pb-4 backdrop-blur-xl">
          <input
            // biome-ignore lint/a11y/noAutofocus: search page needs immediate focus
            autoFocus
            type="text"
            value={search}
            onChange={(e) =>
              navigate({
                to: '/hmrc',
                search: { search: e.target.value },
                replace: true,
              })
            }
            placeholder="Search organisations (min 3 characters)..."
            className="w-full rounded-lg border border-(--sea-ink-soft)/20 bg-transparent px-4 py-3 text-lg text-(--sea-ink) placeholder:text-(--sea-ink-soft)/50 focus:border-(--sea-ink) focus:outline-none focus:ring-1 focus:ring-(--sea-ink)"
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
                    key={r.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    <div className="glass flex items-center justify-between gap-4 rounded-lg p-4">
                      <div className="min-w-0">
                        <Tooltip text={r.organisationName}>
                          <h3 className="heading-card cursor-pointer truncate text-base font-semibold text-(--sea-ink)">
                            {r.organisationName}
                          </h3>
                        </Tooltip>
                        <Tooltip
                          text={[r.townCity, r.county]
                            .filter(Boolean)
                            .join(', ')}
                        >
                          <p className="cursor-pointer truncate text-sm text-(--sea-ink-soft)">
                            {[r.townCity, r.county].filter(Boolean).join(', ')}
                          </p>
                        </Tooltip>
                        <Tooltip text={r.route}>
                          <p className="mt-1 cursor-pointer truncate text-xs text-(--sea-ink-soft)">
                            {r.route}
                          </p>
                        </Tooltip>
                      </div>
                      <span className="shrink-0 text-xs text-(--kicker)">
                        {r.typeRating}
                      </span>
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
