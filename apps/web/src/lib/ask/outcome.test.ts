import { describe, expect, test } from 'bun:test';

import type { AskPlanResponse } from './ask-loader';
import { askOutcome } from './outcome';
import { RANKED_MAX } from './ranked-ids';

const base = {
  filters: { location: 'Oxford' },
  base: {},
  reason: 'none' as const,
  span: 'semi-conductor business',
  sector: 'C',
  failed: false,
};

describe('askOutcome', () => {
  test('a slice that kept companies answers with the ranking under the filters, naming the next slice when the shortlist was full', () => {
    expect(
      askOutcome({
        ...base,
        slice: { ranked: ['00000001', '00000002'], shortlisted: RANKED_MAX },
      }),
    ).toEqual({
      status: 'ok',
      filters: { location: 'Oxford' },
      reason: 'none',
      ranking: {
        span: 'semi-conductor business',
        sector: 'C',
        tranches: [['00000001', '00000002']],
        next: RANKED_MAX,
      },
    });
    expect(
      askOutcome({ ...base, slice: { ranked: ['00000001'], shortlisted: 2 } }),
    ).toMatchObject({ ranking: { next: null } });
  });

  test('a sort the question or the base asks for pins the ranking to its first slice: no next slice, however full the shortlist', () => {
    const full = { ranked: ['00000001'], shortlisted: RANKED_MAX };
    expect(
      askOutcome({
        ...base,
        filters: { location: 'Oxford', sort: 'incorporated', order: 'desc' },
        slice: full,
      }),
    ).toMatchObject({ ranking: { next: null } });
    expect(
      askOutcome({ ...base, base: { sort: 'name' }, slice: full }),
    ).toMatchObject({ ranking: { next: null } });
    expect(askOutcome({ ...base, slice: full })).toMatchObject({
      ranking: { next: RANKED_MAX },
    });
  });

  test('a slice judged that kept none, or nothing to judge under the filters, is unmatched with no filters: the filters alone would pass for the answer', () => {
    const unmatched: AskPlanResponse = {
      status: 'ok',
      filters: {},
      reason: 'unmatched',
      ranking: null,
    };
    expect(
      askOutcome({ ...base, slice: { ranked: [], shortlisted: 2 } }),
    ).toEqual(unmatched);
    expect(
      askOutcome({ ...base, slice: { ranked: [], shortlisted: 0 } }),
    ).toEqual(unmatched);
  });

  test('a rerank that failed loses the ranking, not the filters; with none to fall back on, nothing can answer', () => {
    expect(askOutcome({ ...base, slice: null, failed: true })).toEqual({
      status: 'ok',
      filters: { location: 'Oxford' },
      reason: 'none',
      ranking: null,
    });
    expect(
      askOutcome({ ...base, filters: {}, slice: null, failed: true }),
    ).toEqual({ status: 'unavailable' });
  });

  test('a plan with no span answers with its filters and its own reason', () => {
    expect(
      askOutcome({ ...base, span: null, slice: null, reason: 'beyond' }),
    ).toEqual({
      status: 'ok',
      filters: { location: 'Oxford' },
      reason: 'beyond',
      ranking: null,
    });
  });
});
