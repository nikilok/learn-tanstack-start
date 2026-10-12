import { useInfiniteQuery } from '@tanstack/react-query';

import { searchHmrc } from '../api/hmrc';
import { retrySessionCall } from '../lib/session/client';

/**
 * Hook wrapping `searchHmrc` in a React Query infinite query. Disabled while
 * `search` is under 3 chars. Returns the flattened result rows plus paging
 * state (`hasMore`, `loadingMore`, `fetchMore`), an `isLoading` flag that
 * stays `false` when the query is disabled, and `failed` when no page could
 * be loaded.
 */
export function useHmrcSearch(search: string) {
  const enabled = search.length >= 3;

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
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

  const results = data?.pages.flatMap((page) => page.rows) ?? [];

  return {
    results,
    isLoading: enabled && isLoading,
    failed: enabled && isError && results.length === 0,
    hasMore: hasNextPage ?? false,
    loadingMore: isFetchingNextPage,
    fetchMore: fetchNextPage,
  };
}
