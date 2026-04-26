import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { Suspense, useRef } from 'react';
import { searchHmrc } from '../api/hmrc';
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
  const { platformInfo } = Route.useRouteContext();
  const navigate = useNavigate();
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isStuck, ready, pillClicked, onPillClick, onPillDismiss } =
    useSearchPill(inputRef, sentinelRef);

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">
          Search UK skilled worker visa sponsors
        </p>
        <div ref={sentinelRef} className="pointer-events-none mt-6" />
        <div
          className={`pointer-events-none z-40 -mx-4 px-4 ${isStuck && pillClicked ? 'fixed left-0 right-0 top-[61px] sm:top-[77px] mx-auto max-w-2xl search-glow pb-4 pt-2' : 'sticky top-[69px] sm:top-[85px] pb-4'}`}
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

        <div className="page-flip-listing">
          <Suspense fallback={<SkeletonCards />}>
            <HmrcResults search={search} />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
