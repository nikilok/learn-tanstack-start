import { describe, expect, test } from 'bun:test';

import type { AskRanking } from './ask-loader';
import { RANKED_MAX } from './ranked-ids';
import {
  EMPTY_TRANCHES_MAX,
  extendRanking,
  isTrancheOffset,
  nextRankedPage,
  nextTrancheOffset,
  TRANCHES_MAX,
  walkedListing,
} from './tranches';

const BOUND = TRANCHES_MAX * RANKED_MAX;

describe('nextTrancheOffset', () => {
  test('a full slice is followed by the next; a short one has run the shortlist out', () => {
    expect(nextTrancheOffset(0, RANKED_MAX)).toBe(RANKED_MAX);
    expect(nextTrancheOffset(RANKED_MAX, RANKED_MAX)).toBe(2 * RANKED_MAX);
    expect(nextTrancheOffset(0, RANKED_MAX - 1)).toBeNull();
    expect(nextTrancheOffset(RANKED_MAX, 0)).toBeNull();
  });

  test('the walk ends at its bound even with a full slice', () => {
    expect(nextTrancheOffset(BOUND - 2 * RANKED_MAX, RANKED_MAX)).toBe(
      BOUND - RANKED_MAX,
    );
    expect(nextTrancheOffset(BOUND - RANKED_MAX, RANKED_MAX)).toBeNull();
  });
});

describe('isTrancheOffset', () => {
  test('a whole slice after the first, under the bound, and nothing else', () => {
    expect(isTrancheOffset(RANKED_MAX)).toBe(true);
    expect(isTrancheOffset(2 * RANKED_MAX)).toBe(true);
    expect(isTrancheOffset(BOUND - RANKED_MAX)).toBe(true);
    for (const bad of [
      0,
      RANKED_MAX / 2,
      RANKED_MAX + 1,
      BOUND,
      -RANKED_MAX,
      RANKED_MAX + 0.5,
      String(RANKED_MAX),
      null,
      undefined,
    ])
      expect(isTrancheOffset(bad)).toBe(false);
  });
});

describe('extendRanking', () => {
  const ranking: AskRanking = {
    span: 'care homes',
    tranches: [['00000001', '00000002']],
    next: RANKED_MAX,
  };

  test('appends the new companies as a tranche and moves the walk on', () => {
    expect(
      extendRanking(
        ranking,
        { ranked: ['00000003', '00000004'], next: 2 * RANKED_MAX },
        0,
      ),
    ).toEqual({
      ranking: {
        span: 'care homes',
        tranches: [
          ['00000001', '00000002'],
          ['00000003', '00000004'],
        ],
        next: 2 * RANKED_MAX,
      },
      emptyRun: 0,
    });
  });

  test('a company already ranked, or named twice, is kept once; a slice that ran the shortlist out ends the walk', () => {
    const { ranking: extended } = extendRanking(
      ranking,
      { ranked: ['00000002', '00000005', '00000005'], next: null },
      0,
    );
    expect(extended.tranches).toEqual([['00000001', '00000002'], ['00000005']]);
    expect(extended.next).toBeNull();
  });

  test('a dry slice appends nothing and counts; the run ends the walk at its limit and a find resets it', () => {
    let run = 0;
    let current = ranking;
    for (let i = 1; i < EMPTY_TRANCHES_MAX; i++) {
      const step = extendRanking(
        current,
        { ranked: [], next: (i + 1) * RANKED_MAX },
        run,
      );
      expect(step.ranking.tranches).toEqual(ranking.tranches);
      expect(step.ranking.next).toBe((i + 1) * RANKED_MAX);
      expect(step.emptyRun).toBe(i);
      run = step.emptyRun;
      current = step.ranking;
    }
    const last = extendRanking(
      current,
      { ranked: [], next: (EMPTY_TRANCHES_MAX + 1) * RANKED_MAX },
      run,
    );
    expect(last.ranking.next).toBeNull();
    expect(last.emptyRun).toBe(EMPTY_TRANCHES_MAX);
    const found = extendRanking(
      ranking,
      { ranked: ['00000009'], next: 2 * RANKED_MAX },
      EMPTY_TRANCHES_MAX - 1,
    );
    expect(found.emptyRun).toBe(0);
    expect(found.ranking.next).toBe(2 * RANKED_MAX);
  });
});

describe('nextRankedPage', () => {
  test('pages on through a tranche, then into the next, then stops', () => {
    expect(
      nextRankedPage(
        { tranche: 0, offset: 0 },
        { hasMore: true, shown: 50, tranches: 1 },
      ),
    ).toEqual({ tranche: 0, offset: 50 });
    expect(
      nextRankedPage(
        { tranche: 0, offset: 50 },
        { hasMore: false, shown: 73, tranches: 2 },
      ),
    ).toEqual({ tranche: 1, offset: 0 });
    expect(
      nextRankedPage(
        { tranche: 1, offset: 0 },
        { hasMore: false, shown: 12, tranches: 2 },
      ),
    ).toBeUndefined();
  });
});

describe('walkedListing', () => {
  const listing = {
    results: [1],
    hasMore: false,
    loadingMore: false,
    moreFailed: false,
  };

  test('a slice to judge keeps the list open, one with the judge is loading, one that failed is a failed page', () => {
    expect(
      walkedListing(listing, { next: null, judging: false, failed: false }),
    ).toEqual(listing);
    expect(
      walkedListing(listing, {
        next: RANKED_MAX,
        judging: false,
        failed: false,
      }).hasMore,
    ).toBe(true);
    expect(
      walkedListing(listing, { next: RANKED_MAX, judging: true, failed: false })
        .loadingMore,
    ).toBe(true);
    expect(
      walkedListing(listing, { next: RANKED_MAX, judging: false, failed: true })
        .moreFailed,
    ).toBe(true);
    expect(
      walkedListing(
        { ...listing, hasMore: true },
        { next: null, judging: false, failed: false },
      ).hasMore,
    ).toBe(true);
  });
});
