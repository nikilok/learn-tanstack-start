import { describe, expect, test } from 'bun:test';

import { indexAfterClose, nextIndex, runDisposition } from './use-ip-tabs';

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

// Regression: a window change while a fetch was running was swallowed by the in-flight guard, so
// the tab kept rendering the OLD window's profile and advice under the NEW window's label, with
// no error and no retry. The operator's only recovery was to guess at R.
describe('runDisposition', () => {
  const busy = new Set(['ip:1.2.3.4']);

  test('nothing in flight always runs', () => {
    expect(runDisposition(new Set(), 'ip:1.2.3.4', false)).toBe('run');
    expect(runDisposition(new Set(), 'ip:1.2.3.4', true)).toBe('run');
  });

  test('an unforced duplicate is dropped — that is the point of the guard', () => {
    expect(runDisposition(busy, 'ip:1.2.3.4', false)).toBe('drop');
  });

  test('a FORCED call is queued, never dropped — it carries a new window', () => {
    expect(runDisposition(busy, 'ip:1.2.3.4', true)).toBe('queue');
  });

  test('a different subject is unaffected by another one loading', () => {
    expect(runDisposition(busy, 'ip:5.6.7.8', false)).toBe('run');
    expect(runDisposition(busy, 'ja4:1.2.3.4', false)).toBe('run');
  });
});
