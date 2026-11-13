import { filterSearchKey, parseSearchFilters } from '@ss/search-filters';
import { useInfiniteQuery } from '@tanstack/react-query';

import { searchRanked } from '../api/filterSearch';
import { nextRankedPage, type RankedPage } from '../lib/ask/tranches';
import { retrySessionCall } from '../lib/session/client';
import { listingState } from './listing-state';

type RankedPageData = Awaited<ReturnType<typeof searchRanked>>;

/**
 * The filtered listing restricted to a question's ranking (lib/ask), tranche
 * by tranche: each judged slice is paged through `searchRanked` with its own
 * ids, in rank order, and the next slice's rows follow once a slice's run
 * out. Keyed by the filters and the first slice alone, so a slice appended
 * while the visitor reads keeps the pages already shown; the next page is
 * decided from the latest slices, so an appended one is paged at once. The
 * shape is `useFilterSearch`'s, for the results list.
 */
export function useRankedSearch(
  params: Record<string, unknown>,
  tranches: string[][],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { filters } = parseSearchFilters(params);
  const live = enabled && tranches.length > 0;
  const key = filterSearchKey(filters);
  const query = useInfiniteQuery({
    queryKey: ['filter-search', key, tranches[0]?.join(',') ?? ''],
    queryFn: ({ pageParam }): Promise<RankedPageData> => {
      const ids = tranches[pageParam.tranche];
      return ids
        ? searchRanked({
            data: {
              params: filters,
              offset: pageParam.offset,
              companyNumbers: ids,
            },
          })
        : Promise.resolve({ rows: [], hasMore: false, issues: [] });
    },
    initialPageParam: { tranche: 0, offset: 0 } as RankedPage,
    // A page's offset is the rows of its slice shown before it, so the rows
    // shown after it need no sum.
    getNextPageParam: (lastPage, _pages, lastParam) =>
      nextRankedPage(lastParam, {
        hasMore: lastPage.hasMore,
        shown: lastParam.offset + lastPage.rows.length,
        tranches: tranches.length,
      }),
    enabled: live,
    retry: retrySessionCall,
    staleTime: 5 * 60 * 1000, // a ranking is fixed for its question
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
