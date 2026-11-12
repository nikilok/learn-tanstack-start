import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  type AppliedAsk,
  clearApplied,
  loadApplied,
  parseApplied,
  saveApplied,
} from './applied-store';
import { paramsKey } from './overlay';

// Minimal in-memory sessionStorage for the test environment.
let store: Record<string, string> = {};
const original = globalThis.sessionStorage;
beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    },
  });
});
afterEach(() => {
  // Bun has no sessionStorage: leave the global exactly as found, not as a
  // read-only `undefined` the next file's stub would trip over.
  if (original === undefined) {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  } else {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: original,
    });
  }
});

const merged = { location: 'Leeds', sicSection: 'Q', rating: 'A' };
const applied: AppliedAsk = {
  text: 'care homes in leeds',
  base: { rating: 'A' },
  mergedKey: paramsKey(merged),
  chips: ['In Leeds', 'Human health and social work activities'],
  ranking: null,
};
const ranking = {
  span: 'care homes',
  sector: null,
  tranches: [['00000001', '00000002']],
  next: null,
};

describe('applied store', () => {
  test('round-trips a plan for the tab', () => {
    saveApplied(applied);
    expect(loadApplied()).toEqual(applied);
    clearApplied();
    expect(loadApplied()).toBeNull();
  });

  test('a ranking round-trips, and one that is not a ranking makes the record corrupt', () => {
    saveApplied({ ...applied, ranking });
    expect(loadApplied()).toEqual({ ...applied, ranking });
    expect(parseApplied({ ...applied, ranking: { span: 'x' } })).toBeNull();
    expect(
      parseApplied({
        ...applied,
        ranking: { ...ranking, tranches: [[1]] },
      }),
    ).toBeNull();
    expect(parseApplied({ ...applied, ranking: undefined })).toEqual(applied);
  });

  test('a walk still going round-trips with its next slice; a next that is no slice’s, no slices, or a record from before the slices is corrupt', () => {
    const walking = {
      ...ranking,
      tranches: [['00000001'], ['00000002', '00000003']],
      next: 800,
    };
    saveApplied({ ...applied, ranking: walking });
    expect(loadApplied()).toEqual({ ...applied, ranking: walking });
    expect(
      parseApplied({ ...applied, ranking: { ...ranking, next: 123 } }),
    ).toBeNull();
    expect(
      parseApplied({ ...applied, ranking: { ...ranking, tranches: [] } }),
    ).toBeNull();
    expect(
      parseApplied({
        ...applied,
        ranking: { span: 'care homes', ranked: ['00000001'] },
      }),
    ).toBeNull();
  });

  test('the sector the question named round-trips; one the registry does not know is corrupt; a record from before it names none', () => {
    const named = { ...ranking, sector: 'K' };
    saveApplied({ ...applied, ranking: named });
    expect(loadApplied()).toEqual({ ...applied, ranking: named });
    expect(
      parseApplied({ ...applied, ranking: { ...ranking, sector: 'ZZ' } }),
    ).toBeNull();
    const before = {
      span: ranking.span,
      tranches: ranking.tranches,
      next: ranking.next,
    };
    expect(parseApplied({ ...applied, ranking: before })).toEqual({
      ...applied,
      ranking,
    });
  });

  test('a corrupt or foreign record is null', () => {
    store['ss-ask'] = '{not json';
    expect(loadApplied()).toBeNull();
    store['ss-ask'] = JSON.stringify({ text: 1, mergedKey: 'x', chips: [] });
    expect(loadApplied()).toBeNull();
    store['ss-ask'] = JSON.stringify({ ...applied, chips: ['ok', 2] });
    expect(loadApplied()).toBeNull();
  });

  test('the base is re-validated through the registry', () => {
    store['ss-ask'] = JSON.stringify({
      ...applied,
      base: { rating: 'A', bogus: 'x', route: 'Not A Route' },
    });
    expect(loadApplied()?.base).toEqual({ rating: 'A' });
  });

  test('parseApplied reads a plan from any value, as a history entry carries one', () => {
    expect(parseApplied(applied)).toEqual(applied);
    expect(parseApplied(JSON.parse(JSON.stringify(applied)))).toEqual(applied);
    for (const bad of [
      null,
      undefined,
      'text',
      42,
      {},
      { ...applied, text: 1 },
      { ...applied, mergedKey: undefined },
      { ...applied, chips: 'In Leeds' },
      { ...applied, chips: ['ok', null] },
    ])
      expect(parseApplied(bad)).toBeNull();
  });

  test('storage that throws keeps nothing and breaks nothing', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    expect(() => saveApplied(applied)).not.toThrow();
    expect(loadApplied()).toBeNull();
    expect(() => clearApplied()).not.toThrow();
  });
});
