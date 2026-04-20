import { useInfiniteQuery } from '@tanstack/react-query';
import { type HmrcRow, searchHmrc } from '../api/hmrc';

export type { HmrcRow };

/**
 * Hook wrapping `searchHmrc` in a React Query infinite query. Disabled while
 * `search` is under 3 chars. Returns the flattened result rows plus paging
 * state (`hasMore`, `loadingMore`, `fetchMore`) and an `isLoading` flag that
 * stays `false` when the query is disabled.
 */
export function useHmrcSearch(search: string) {
  const enabled = search.length >= 3;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
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
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes
    });

  const results = data?.pages.flatMap((page) => page.rows) ?? [];

  return {
    results,
    isLoading: enabled && isLoading,
    hasMore: hasNextPage ?? false,
    loadingMore: isFetchingNextPage,
    fetchMore: fetchNextPage,
  };
}
