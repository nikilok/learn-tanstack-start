import { useQuery } from '@tanstack/react-query';
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { Suspense, useEffect, useRef, useState } from 'react';

import { searchFiltered } from '../api/filterSearch';
import { searchHmrc, sponsorCountQueryOptions } from '../api/hmrc';
import HeroText from '../components/HeroText';
import HmrcResults from '../components/HmrcResults';
import SearchBar from '../components/SearchBar';
import SkeletonCards from '../components/SkeletonCards';
import { filterSearchKey, useFilterSearch } from '../hooks/useFilterSearch';
import { useHmrcSearch } from '../hooks/useHmrcSearch';
import { parsePlatform } from '../hooks/usePlatform';
import { useSearchPill } from '../hooks/useSearchPill';
import {
  filtersToSearchParams,
  parseSearchFilters,
  searchTermInput,
  type SearchUrlParams,
} from '../lib/search/params';
import { loadStoredFilters, storeFilters } from '../lib/search/persist';
import { buildCanonical } from '../utils/canonical';

const getPlatformInfo = createIsomorphicFn()
  .client(() => parsePlatform(navigator.userAgent))
  .server(() => parsePlatform(getRequestHeader('user-agent') ?? ''));

// The first mount after SSR must render exactly the server HTML (which cannot
// read localStorage); every later SPA mount is free to read it synchronously.
let hydrationDone = false;

// What a bare mount renders while the rehydrate effect below re-applies the
// stored filters: a loading frame, so the classic hook neither fires a
// spurious name search nor lets a pending scroll restore be discarded.
const PENDING_FILTER_DATA = {
  results: [],
  isLoading: true,
  hasMore: false,
  loadingMore: false,
  fetchMore: () => {},
};

export const Route = createFileRoute('/')({
  // The name term (`search`) plus the URL-form filter params from /filters.
  // `q` is stripped: on this surface the name term only comes from `search`.
  validateSearch: (search: Record<string, unknown>) => {
    const { filters } = parseSearchFilters({ ...search, q: undefined });
    return {
      search: searchTermInput(search.search),
      ...filtersToSearchParams(filters),
    };
  },
  search: {
    // Value-strip of a REQUIRED key: runtime-supported (and long-standing
    // behavior here), but PickOptional-typed to optional keys only — the
    // filter params joining the schema surfaced that, hence the cast.
    middlewares: [stripSearchParams({ search: '' } as never)],
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
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ context: { queryClient }, deps }) => {
    const { search: term, ...urlFilters } = (
      deps as { search: { search: string } & SearchUrlParams }
    ).search;
    if (typeof window !== 'undefined') return;
    if (Object.keys(urlFilters).length > 0) {
      // Filter mode: with or without a name term, the filter endpoint serves
      // the listing. Key/params must mirror useFilterSearch exactly.
      const { filters } = parseSearchFilters({
        ...urlFilters,
        q: term.length >= 3 ? term : undefined,
      });
      queryClient.prefetchInfiniteQuery({
        queryKey: ['filter-search', filterSearchKey(filters)],
        queryFn: () => searchFiltered({ data: { params: filters, offset: 0 } }),
        initialPageParam: 0,
      });
    } else if (term.length >= 3) {
      // Don't await — let the query stream in while the shell renders
      queryClient.prefetchInfiniteQuery({
        queryKey: ['hmrc-search', term],
        queryFn: () => searchHmrc({ data: { query: term, offset: 0 } }),
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
  const { search, ...urlFilters } = Route.useSearch();
  const hasFilters = Object.values(urlFilters).some(
    (value) => value !== undefined,
  );
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

  // A bare-URL SPA mount (details back-link, header logo) with a stored
  // filter set is about to rehydrate into filter mode — known synchronously,
  // so the transient render never runs the classic search. False on the
  // hydration mount by construction (hydrationDone), so server HTML matches.
  const [pendingStoredFilters, setPendingStoredFilters] = useState(
    () => hydrationDone && !hasFilters && loadStoredFilters() != null,
  );
  useEffect(() => {
    hydrationDone = true;
  }, []);

  // Both data sources stay mounted; only one is live. No filters → the
  // classic name search exactly as before ('' disables it via the >=3 gate).
  // Any filter → the filter endpoint serves the listing, with the typed term
  // passed through as `q` once it reaches 3 chars.
  const classic = useHmrcSearch(
    hasFilters || pendingStoredFilters ? '' : search,
  );
  const filtered = useFilterSearch(
    { ...urlFilters, q: search.length >= 3 ? search : undefined },
    { enabled: hasFilters },
  );
  const resultsData = hasFilters
    ? filtered
    : pendingStoredFilters
      ? PENDING_FILTER_DATA
      : classic;

  // Applied filters are durable: the URL is authoritative when it carries
  // them (and refreshes the store), but navs that only carry the name term —
  // details back-links, the header logo — get the stored set re-applied.
  // The only way OUT of filter mode is /filters' Reset, which empties the
  // store.
  const urlFiltersKey = JSON.stringify(urlFilters);
  useEffect(() => {
    if (hasFilters) {
      storeFilters(JSON.parse(urlFiltersKey) as Record<string, unknown>);
      return;
    }
    const stored = loadStoredFilters();
    if (stored) {
      navigate({ to: '/', search: { search, ...stored }, replace: true });
    } else {
      // Nothing to rehydrate (e.g. cleared in another tab) — release the
      // pending frame so the classic path takes over.
      setPendingStoredFilters(false);
    }
  }, [hasFilters, urlFiltersKey, search, navigate]);

  // Empty state: the hero is shown and the search bar scrolls away with the
  // page (not sticky). It only sticks once a query or filter set exists.
  const heroVisible =
    liveQuery.length === 0 &&
    search.length === 0 &&
    !hasFilters &&
    !pendingStoredFilters;
  // data-search-pinned gates SearchInput's translateZ cursor fix and must
  // track a typed query ONLY: stamped with an empty input (nameless filter
  // mode) it garbles the rotating placeholder on iOS Safari (see CLAUDE.md).
  const hasQueryText = liveQuery.length > 0 || search.length > 0;

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">
          Search UK companies
          {!platformInfo.isMobile && (
            <span
              style={{
                opacity: hasFilters || search.length >= 3 ? 1 : 0,
                transition: 'opacity 250ms ease',
                pointerEvents: 'none',
                color: 'var(--kicker)',
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
          data-search-pinned={hasQueryText ? '' : undefined}
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
            filtersActive={hasFilters || pendingStoredFilters}
            inputRef={inputRef}
            platform={platformInfo.platform}
            isMobile={platformInfo.isMobile}
            onSearch={(value) => {
              setLiveQuery(value);
              if (navTimerRef.current) clearTimeout(navTimerRef.current);
              navTimerRef.current = setTimeout(() => {
                navigate({
                  to: '/',
                  // Functional update: typing must not wipe active filters.
                  search: (prev) => ({ ...prev, search: value }),
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
            <HmrcResults
              search={search}
              filtersActive={hasFilters || pendingStoredFilters}
              data={resultsData}
            />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
