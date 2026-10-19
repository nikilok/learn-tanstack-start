import { describe, expect, test } from 'bun:test';

import {
  MAX_SEARCHES_PER_RUN,
  MAX_SEARCHES_PER_WORKER,
  MAX_SHARDS,
  parseShard,
  WHOLE_SET,
  workerSearchCeiling,
} from './shard';

describe('parseShard', () => {
  test('no flag means the whole set', () => {
    expect(parseShard(undefined)).toEqual(WHOLE_SET);
  });

  test('reads K/N', () => {
    expect(parseShard('3/12')).toEqual({ index: 3, count: 12 });
    expect(parseShard('0/1')).toEqual(WHOLE_SET);
    expect(parseShard(`15/${MAX_SHARDS}`)).toEqual({
      index: 15,
      count: MAX_SHARDS,
    });
  });

  test.each([
    ['12/12'],
    ['0/0'],
    [`0/${MAX_SHARDS + 1}`],
    ['-1/4'],
    ['1/4/5'],
    ['a/b'],
    ['1.5/4'],
    [''],
    [' 1/4'],
    ['1/4 '],
    ['1 /4'],
    ['3'],
    ['100/120'],
  ])('rejects %p', (raw) => {
    // A malformed shard must stop the run: silently falling back to the
    // whole set would put this worker on its peers' companies, paid twice.
    expect(() => parseShard(raw)).toThrow(/Invalid shard/);
  });
});

describe('workerSearchCeiling', () => {
  test('one worker keeps the old per-run ceiling', () => {
    expect(workerSearchCeiling(WHOLE_SET)).toBe(MAX_SEARCHES_PER_WORKER);
  });

  test('a wide split shares the run ceiling', () => {
    expect(workerSearchCeiling({ index: 0, count: 12 })).toBe(2500);
    expect(workerSearchCeiling({ index: 7, count: 8 })).toBe(3750);
  });

  test('no split of any width can spend past the run ceiling', () => {
    for (let count = 1; count <= MAX_SHARDS; count++) {
      const ceiling = workerSearchCeiling({ index: 0, count });
      expect(ceiling).toBeGreaterThan(0);
      expect(ceiling).toBeLessThanOrEqual(MAX_SEARCHES_PER_WORKER);
      expect(ceiling * count).toBeLessThanOrEqual(MAX_SEARCHES_PER_RUN);
    }
  });
});
