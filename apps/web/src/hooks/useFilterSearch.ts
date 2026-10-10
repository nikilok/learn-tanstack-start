import { filterSearchKey, parseSearchFilters } from '@ss/search-filters';
import { useInfiniteQuery } from '@tanstack/react-query';

import { searchFiltered, searchRanked } from '../api/filterSearch';
import { retrySessionCall } from '../lib/session/client';
import { listingState } from './listing-state';

/**
 * Hook wrapping `searchFiltered` in an infinite query. Takes raw URL-form
 * params (the home route's filter state plus q), parses them to canonical
 * filters for a stable cache key, and sends the canonical form. An empty
 * filter set is the browse-everything directory. Exposes the server's
 * `issues` echo from page 0, `failed` and `moreFailed` (`listingState`), and
 * `retry` for the first page. With `ranked`, the ask's ranked companies in
 * that order through `searchRanked`, keyed by the ids too; an empty set runs
 * nothing and lists nothing.
 */
export function useFilterSearch(
  params: Record<string, unknown>,
  { enabled = true, ranked }: { enabled?: boolean; ranked?: string[] } = {},
) {
  const { filters } = parseSearchFilters(params);
  const live = enabled && (ranked === undefined || ranked.length > 0);
  const key = filterSearchKey(filters);
  const query = useInfiniteQuery({
    queryKey:
      ranked === undefined
        ? ['filter-search', key]
        : ['filter-search', key, ranked.join(',')],
    queryFn: ({ pageParam = 0 }) =>
      ranked === undefined
        ? searchFiltered({ data: { params: filters, offset: pageParam } })
        : searchRanked({
            data: {
              params: filters,
              offset: pageParam,
              companyNumbers: ranked,
            },
          }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.reduce((sum, page) => sum + page.rows.length, 0);
    },
    enabled: live,
    retry: retrySessionCall,
    staleTime: 5 * 60 * 1000, // matches the fn's 5-minute edge TTL; a ranking is fixed for its question
    gcTime: 10 * 60 * 1000,
  });

  // Named, not spread: a spread reads every tracked field, and would re-render
  // on any change to any of them.
  return {
    ...listingState({
      enabled: live,
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
