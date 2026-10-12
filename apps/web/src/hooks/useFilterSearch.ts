import { useInfiniteQuery } from '@tanstack/react-query';

import { searchFiltered } from '../api/filterSearch';
import { parseSearchFilters, type SearchFilters } from '../lib/search/params';
import { retrySessionCall } from '../lib/session/client';

/** Stable cache-key serialization of a canonical filter set (keys sorted). */
export function filterSearchKey(filters: SearchFilters): string {
  return JSON.stringify(filters, Object.keys(filters).sort());
}

/**
 * Hook wrapping `searchFiltered` in an infinite query. Takes raw URL-form
 * params (the home route's filter state plus q), parses them to canonical
 * filters for a stable cache key, and sends the canonical form. An empty
 * filter set is the browse-everything directory. Exposes the server's
 * `issues` echo from page 0, and `failed` when no page could be loaded.
 */
export function useFilterSearch(
  params: Record<string, unknown>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { filters } = parseSearchFilters(params);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
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

  const results = data?.pages.flatMap((page) => page.rows) ?? [];

  return {
    results,
    issues: data?.pages[0]?.issues ?? [],
    isLoading: enabled && isLoading,
    failed: enabled && isError && results.length === 0,
    hasMore: hasNextPage ?? false,
    loadingMore: isFetchingNextPage,
    fetchMore: fetchNextPage,
  };
}
