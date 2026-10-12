import { useInfiniteQuery } from '@tanstack/react-query';

import { searchFiltered } from '../api/filterSearch';
import { parseSearchFilters, type SearchFilters } from '../lib/search/params';
import { retrySessionCall } from '../lib/session/client';
import { listingState } from './listing-state';

/** Stable cache-key serialization of a canonical filter set (keys sorted). */
export function filterSearchKey(filters: SearchFilters): string {
  return JSON.stringify(filters, Object.keys(filters).sort());
}

/**
 * Hook wrapping `searchFiltered` in an infinite query. Takes raw URL-form
 * params (the home route's filter state plus q), parses them to canonical
 * filters for a stable cache key, and sends the canonical form. An empty
 * filter set is the browse-everything directory. Exposes the server's
 * `issues` echo from page 0, `failed` and `moreFailed` (`listingState`), and
 * `retry` for the first page.
 */
export function useFilterSearch(
  params: Record<string, unknown>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { filters } = parseSearchFilters(params);
  const query = useInfiniteQuery({
    queryKey: ['filter-search', filterSearchKey(filters)],
    queryFn: ({ pageParam = 0 }) =>
      searchFiltered({ data: { params: filters, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.reduce((sum, page) => sum + page.rows.length, 0);
    },
    enabled,
    retry: retrySessionCall,
    staleTime: 5 * 60 * 1000, // matches the fn's 5-minute edge TTL
    gcTime: 10 * 60 * 1000,
  });

  // Named, not spread: a spread reads every tracked field, and would re-render
  // on any change to any of them.
  return {
    ...listingState({
      enabled,
      data: query.data,
      isError: query.isError,
      isFetchNextPageError: query.isFetchNextPageError,
      isFetchingNextPage: query.isFetchingNextPage,
      isLoading: query.isLoading,
      hasNextPage: query.hasNextPage,
    }),
    issues: query.data?.pages[0]?.issues ?? [],
    retry: () => void query.refetch(),
    fetchMore: query.fetchNextPage,
  };
}
