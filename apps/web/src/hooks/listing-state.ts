/** The parts of a search listing's infinite query the results list reads. */
export type ListingQuery<Row> = {
  enabled: boolean;
  data: { pages: Array<{ rows: Row[] }> } | undefined;
  isError: boolean;
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
  isLoading: boolean;
  hasNextPage: boolean;
};

/**
 * What a search listing's query comes to, for both search hooks: its rows, and whether it is
 * loading, `failed` (no page could be loaded at all) or `moreFailed` (the next one could not). A
 * refetch that fails keeps what was found, an empty result included, so it is no failure.
 */
export function listingState<Row>(query: ListingQuery<Row>) {
  return {
    results: query.data?.pages.flatMap((page) => page.rows) ?? [],
    isLoading: query.enabled && query.isLoading,
    failed: query.enabled && query.isError && query.data === undefined,
    moreFailed: query.isFetchNextPageError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
  };
}

/** How near the end of the rows the list scrolls before it asks for the next page. */
const MORE_WITHIN_ROWS = 10;

/**
 * Whether scrolling to row `lastShown` asks for the next page: near the end, with more to come and
 * none on its way. A next page that failed is not asked for again by scrolling: it would be, at
 * once and without end, as the failure leaves `hasMore` set.
 */
export function wantsMore(list: {
  lastShown: number;
  rows: number;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
}): boolean {
  return (
    list.lastShown >= list.rows - MORE_WITHIN_ROWS &&
    list.hasMore &&
    !list.loadingMore &&
    !list.moreFailed
  );
}
