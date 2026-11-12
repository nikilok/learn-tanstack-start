import { describe, expect, test } from 'bun:test';

import { canonicalSearchParams } from '@ss/search-filters';

import { isSector } from './sector';

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
