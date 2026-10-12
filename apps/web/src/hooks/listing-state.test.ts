import { describe, expect, test } from 'bun:test';

import { type ListingQuery, listingState, wantsMore } from './listing-state';

describe('wantsMore', () => {
  const nearEnd = {
    lastShown: 45,
    rows: 50,
    hasMore: true,
    loadingMore: false,
    moreFailed: false,
  };

  test('scrolling near the end asks for the next page', () => {
    expect(wantsMore(nearEnd)).toBe(true);
    expect(wantsMore({ ...nearEnd, lastShown: 20 })).toBe(false);
  });

  test('not while one is on its way, nor with none to come', () => {
    expect(wantsMore({ ...nearEnd, loadingMore: true })).toBe(false);
    expect(wantsMore({ ...nearEnd, hasMore: false })).toBe(false);
  });

  test('a next page that failed is not asked for again by scrolling', () => {
    expect(wantsMore({ ...nearEnd, moreFailed: true })).toBe(false);
  });
});

const idle: ListingQuery<string> = {
  enabled: true,
  data: undefined,
  isError: false,
  isFetchNextPageError: false,
  isFetchingNextPage: false,
  isLoading: false,
  hasNextPage: false,
};

describe('listingState', () => {
  test('a first page that could not load is a failure, not an empty result', () => {
    expect(listingState({ ...idle, isError: true })).toMatchObject({
      results: [],
      failed: true,
    });
  });

  test('a refetch that fails keeps what was found, an empty result included', () => {
    for (const rows of [[], ['acme']])
      expect(
        listingState({ ...idle, isError: true, data: { pages: [{ rows }] } }),
      ).toMatchObject({ results: rows, failed: false });
  });

  test('a next page that could not load is told apart from the first', () => {
    expect(
      listingState({
        ...idle,
        isError: true,
        isFetchNextPageError: true,
        hasNextPage: true,
        data: { pages: [{ rows: ['acme'] }] },
      }),
    ).toMatchObject({ failed: false, moreFailed: true, hasMore: true });
  });

  test('a query that is off is neither loading nor failed', () => {
    expect(
      listingState({ ...idle, enabled: false, isError: true, isLoading: true }),
    ).toMatchObject({ isLoading: false, failed: false });
  });

  test('the pages are read as one list of rows', () => {
    expect(
      listingState({
        ...idle,
        data: { pages: [{ rows: ['a', 'b'] }, { rows: ['c'] }] },
      }).results,
    ).toEqual(['a', 'b', 'c']);
  });
});
