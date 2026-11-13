import { describe, expect, test } from 'bun:test';

import { canonicalSearchParams } from '@ss/search-filters';

import { isSector, placeSector } from './sector';

describe('isSector', () => {
  test('a section the registry accepts, in its canonical form, is a sector; anything else is not', () => {
    expect(isSector('K')).toBe(true);
    const two = canonicalSearchParams({ sicSection: 'K,J' }).sicSection;
    expect(typeof two).toBe('string');
    expect(isSector(two)).toBe(true);
    expect(isSector('ZZ')).toBe(false);
    expect(isSector('K,ZZ')).toBe(false);
    expect(isSector('')).toBe(false);
    expect(isSector(null)).toBe(false);
    expect(isSector(42)).toBe(false);
    expect(isSector(['K'])).toBe(false);
  });
});

describe('placeSector', () => {
  test('a judged slice carries the sector as a preference; nothing to rank leaves it a filter; no sector places nothing', () => {
    expect(placeSector('K', 400)).toEqual({ preference: 'K', filter: null });
    expect(placeSector('K', 0)).toEqual({ preference: null, filter: 'K' });
    expect(placeSector(null, 400)).toEqual({ preference: null, filter: null });
  });
});
