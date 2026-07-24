import { beforeEach, describe, expect, test } from 'bun:test';

import { loadStoredFilters, storeFilters } from './persist';

// Minimal in-memory localStorage for the node test environment.
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
} as Storage;

describe('filter persistence', () => {
  beforeEach(() => store.clear());

  test('round-trips an applied filter set through registry validation', () => {
    storeFilters({ route: 'Skilled Worker', hasMoved: true });
    expect(loadStoredFilters()).toEqual({
      route: 'Skilled Worker',
      hasMoved: true,
    });
  });

  test('an empty set clears the store', () => {
    storeFilters({ route: 'Skilled Worker' });
    storeFilters({});
    expect(store.size).toBe(0);
    expect(loadStoredFilters()).toBeNull();
  });

  test('corrupt or stale entries load as null, not junk', () => {
    store.set('ss-filters', 'not json{');
    expect(loadStoredFilters()).toBeNull();
    // A stored value whose only content no longer validates cleans to null.
    store.set('ss-filters', JSON.stringify({ rating: 'discontinued-tier' }));
    expect(loadStoredFilters()).toBeNull();
  });
});
