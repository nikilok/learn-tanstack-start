import { useQuery } from '@tanstack/react-query';
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { Suspense, useEffect, useRef, useState } from 'react';

import { searchHmrc, sponsorCountQueryOptions } from '../api/hmrc';
import HeroText from '../components/HeroText';
import HmrcResults from '../components/HmrcResults';
import SearchBar from '../components/SearchBar';
import SkeletonCards from '../components/SkeletonCards';
import { parsePlatform } from '../hooks/usePlatform';
import { useSearchPill } from '../hooks/useSearchPill';
import { buildCanonical } from '../utils/canonical';

const getPlatformInfo = createIsomorphicFn()
  .client(() => parsePlatform(navigator.userAgent))
  .server(() => parsePlatform(getRequestHeader('user-agent') ?? ''));

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    search: ((search.search as string) || '').trim(),
  }),
  search: {
    middlewares: [stripSearchParams({ search: '' })],
  },
  head: ({ match }) => ({
    links: [
      {
        rel: 'canonical',
        href: buildCanonical(match.pathname),
      },
    ],
  }),
  beforeLoad: () => ({ platformInfo: getPlatformInfo() }),
  loaderDeps: ({ search: { search } }) => ({ search }),
  loader: async ({ context: { queryClient }, deps }) => {
    const { search } = deps as { search: string };
    if (typeof window !== 'undefined') return;
    if (search.length >= 3) {
      // Don't await — let the query stream in while the shell renders
      queryClient.prefetchInfiniteQuery({
        queryKey: ['hmrc-search', search],
        queryFn: () => searchHmrc({ data: { query: search, offset: 0 } }),
        initialPageParam: 0,
      });
    }
  },
  component: Home,
});

/**
 * Landing page component: renders the search bar (with sticky/pill behavior
 * via `useSearchPill`) and a Suspense-wrapped `HmrcResults` list. Debounces
 * typing by 450ms before pushing the query into the `search` URL param via
 * `navigate({ replace: true })` so history isn't spammed on each keystroke.
 */
function Home() {
  const { search } = Route.useSearch();
  // Live input value (updates on every keystroke); the `search` URL param is
  // debounced 450ms, so we gate the hero on this to hide it instantly on type.
  const [liveQuery, setLiveQuery] = useState(search);
  // Re-sync when `search` changes from outside the input (header logo, back/
  // forward, programmatic nav) so the hero/sticky gate never goes stale. During
  // typing this is a no-op: the debounce only commits the latest value, which
  // onSearch already wrote to liveQuery.
  useEffect(() => {
    setLiveQuery(search);
  }, [search]);
  // Non-blocking: SSR-hydrated, streams in on cold client navs (may be undefined).
  const { data: sponsorCount } = useQuery(sponsorCountQueryOptions);
  const { platformInfo } = Route.useRouteContext();
  const navigate = useNavigate();
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isStuck, ready, pillClicked, onPillClick, onPillDismiss } =
    useSearchPill(inputRef, sentinelRef);

  // Empty state: the hero is shown and the search bar scrolls away with the
  // page (not sticky). It only sticks once a query exists.
  const heroVisible = liveQuery.length === 0 && search.length === 0;

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">
          Search UK skilled worker visa sponsors
          {!platformInfo.isMobile && (
            <span
              style={{
                opacity: search.length >= 3 ? 1 : 0,
                transition: 'opacity 250ms ease',
                pointerEvents: 'none',
              }}
            >
              {' · '}
              <kbd>↑</kbd> <kbd>↓</kbd> to navigate
              {' · '}
              <kbd>↵</kbd> to view
            </span>
          )}
        </p>
        <div ref={sentinelRef} className="pointer-events-none mt-6" />
        <div
          data-sticky-search
          data-search-pinned={heroVisible ? undefined : ''}
          className={`pointer-events-none z-40 -mx-4 px-4 ${
            heroVisible
              ? 'relative pb-4'
              : isStuck && pillClicked
                ? 'search-glow fixed top-[61px] right-0 left-0 mx-auto max-w-2xl pt-2 pb-4 sm:top-[77px]'
                : 'sticky top-[69px] pb-4 sm:top-[85px]'
          }`}
        >
          <SearchBar
            search={search}
            isStuck={isStuck}
            ready={ready}
            pillClicked={pillClicked}
            inputRef={inputRef}
            platform={platformInfo.platform}
            isMobile={platformInfo.isMobile}
            onSearch={(value) => {
              setLiveQuery(value);
              if (navTimerRef.current) clearTimeout(navTimerRef.current);
              navTimerRef.current = setTimeout(() => {
                navigate({
                  to: '/',
                  search: { search: value },
                  replace: true,
                });
              }, 450);
            }}
            onPillClick={onPillClick}
            onBlur={onPillDismiss}
          />
        </div>

        {/* Hero shows only when input AND debounced search are both empty, so it
            appears only after the results grid has fully cleared. */}
        {heroVisible && <HeroText count={sponsorCount} />}

        <div className="page-flip-listing">
          <Suspense fallback={<SkeletonCards />}>
            <HmrcResults search={search} />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
