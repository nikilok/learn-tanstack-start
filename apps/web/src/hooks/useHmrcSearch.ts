import { useInfiniteQuery } from '@tanstack/react-query';

import { searchHmrc } from '../api/hmrc';
import { retrySessionCall } from '../lib/session/client';
import { listingState } from './listing-state';

/**
 * Hook wrapping `searchHmrc` in a React Query infinite query. Disabled while
 * `search` is under 3 chars. Returns the flattened result rows plus paging
 * state (`hasMore`, `loadingMore`, `fetchMore`), an `isLoading` flag that
 * stays `false` when the query is disabled, `failed` and `moreFailed`
 * (`listingState`), and `retry` for the first page.
 */
export function useHmrcSearch(search: string) {
  const enabled = search.length >= 3;

  const query = useInfiniteQuery({
    queryKey: ['hmrc-search', search],
    queryFn: async ({ pageParam = 0 }) => {
      return searchHmrc({ data: { query: search, offset: pageParam } });
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.reduce((total, page) => total + page.rows.length, 0);
    },
    enabled,
    retry: retrySessionCall,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
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
    retry: () => void query.refetch(),
    fetchMore: query.fetchNextPage,
  };
}
