import { describe, expect, test } from 'bun:test';

import { indexAfterClose, nextIndex } from './use-ip-tabs';

describe('nextIndex', () => {
  test('advances and wraps past the end', () => {
    expect(nextIndex(0, 3, 1)).toBe(1);
    expect(nextIndex(2, 3, 1)).toBe(0);
  });

  test('goes back and wraps past the start', () => {
    expect(nextIndex(2, 3, -1)).toBe(1);
    expect(nextIndex(0, 3, -1)).toBe(2);
  });

  test('a single tab stays put in both directions', () => {
    expect(nextIndex(0, 1, 1)).toBe(0);
    expect(nextIndex(0, 1, -1)).toBe(0);
  });

  test('no tabs never produces a negative or out-of-range index', () => {
    expect(nextIndex(0, 0, 1)).toBe(0);
    expect(nextIndex(0, 0, -1)).toBe(0);
  });
});

describe('indexAfterClose', () => {
  test('closing a middle tab keeps the slot, so the next tab slides in', () => {
    // [a,b,c] close index 1 -> [a,c]; index 1 is now c.
    expect(indexAfterClose(1, 2)).toBe(1);
  });

  test('closing the last tab falls back onto the new last', () => {
    // [a,b,c] close index 2 -> [a,b]; clamp 2 down to 1.
    expect(indexAfterClose(2, 2)).toBe(1);
  });

  test('closing the only tab lands on 0 rather than -1', () => {
    expect(indexAfterClose(0, 0)).toBe(0);
  });

  test('closing the first of many stays at the front', () => {
    expect(indexAfterClose(0, 3)).toBe(0);
  });
});
