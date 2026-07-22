import { useInfiniteQuery } from '@tanstack/react-query';

import { searchFiltered } from '../api/filterSearch';
import { parseSearchFilters, type SearchFilters } from '../lib/search/params';

/** Stable cache-key serialization of a canonical filter set (keys sorted). */
export function filterSearchKey(filters: SearchFilters): string {
  return JSON.stringify(filters, Object.keys(filters).sort());
}

/**
 * Hook wrapping `searchFiltered` in an infinite query. Takes the raw
 * URL-form params (the /search route state), parses them to canonical
 * filters for a stable cache key, and sends the canonical form. Always
 * enabled — an empty filter set is the browse-everything directory. Exposes
 * `total` and the server's `issues` echo from page 0.
 */
export function useFilterSearch(params: Record<string, unknown>) {
  const { filters } = parseSearchFilters(params);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: ['filter-search', filterSearchKey(filters)],
      queryFn: ({ pageParam = 0 }) =>
        searchFiltered({ data: { params: filters, offset: pageParam } }),
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) => {
        if (!lastPage.hasMore) return undefined;
        return allPages.reduce((sum, page) => sum + page.rows.length, 0);
      },
      staleTime: 5 * 60 * 1000, // matches the fn's 5-minute edge TTL
      gcTime: 10 * 60 * 1000,
    });

  return {
    results: data?.pages.flatMap((page) => page.rows) ?? [],
    total: data?.pages[0]?.total ?? null,
    issues: data?.pages[0]?.issues ?? [],
    isLoading,
    hasMore: hasNextPage ?? false,
    loadingMore: isFetchingNextPage,
    fetchMore: fetchNextPage,
  };
}
