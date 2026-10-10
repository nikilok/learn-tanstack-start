import { describe, expect, test } from 'bun:test';

import { SHORTLIST_MAX } from '@nikilok/thoth-engine';

import { RANKED_MAX, rankedIds } from './ranked-ids';

describe('rankedIds', () => {
  test('the cap is the engine’s shortlist cap', () => {
    expect(RANKED_MAX).toBe(SHORTLIST_MAX);
  });

  test('accepts a list of company numbers up to the shortlist cap and nothing else', () => {
    expect(rankedIds(['00007663', 'SC123456'])).toEqual([
      '00007663',
      'SC123456',
    ]);
    expect(rankedIds([])).toBeNull();
    expect(rankedIds(['0000 7663'])).toBeNull();
    expect(rankedIds(['ok', 42])).toBeNull();
    expect(rankedIds('00007663')).toBeNull();
    const cap = Array.from({ length: SHORTLIST_MAX }, () => 'A');
    expect(rankedIds(cap)).toHaveLength(SHORTLIST_MAX);
    expect(rankedIds([...cap, 'A'])).toBeNull();
  });
});
