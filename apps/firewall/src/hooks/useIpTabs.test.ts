import { describe, expect, test } from 'bun:test';

import {
  indexAfterClose,
  newSubjects,
  nextIndex,
  runDisposition,
} from './useIpTabs';

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

// `o` in the picker opens the whole shortlist. Opening a subject twice would give one identity
// two tabs racing the same fetch, and the second would win an in-flight guard it never asked for.
describe('newSubjects', () => {
  const ip = (v: string) => ({ kind: 'ip' as const, value: v });
  const ja4 = (v: string) => ({ kind: 'ja4' as const, value: v });

  test('returns everything when nothing is open', () => {
    expect(newSubjects([], [ip('1.1.1.1'), ip('2.2.2.2')])).toHaveLength(2);
  });

  test('skips subjects already open', () => {
    expect(
      newSubjects([ip('1.1.1.1')], [ip('1.1.1.1'), ip('2.2.2.2')]),
    ).toEqual([ip('2.2.2.2')]);
  });

  test('collapses duplicates WITHIN the incoming list', () => {
    expect(newSubjects([], [ip('1.1.1.1'), ip('1.1.1.1')])).toEqual([
      ip('1.1.1.1'),
    ]);
  });

  test('an IP and a JA4 of the same text are different subjects', () => {
    // The key is kind-scoped; collapsing these would silently drop one.
    expect(newSubjects([ip('abc')], [ja4('abc')])).toEqual([ja4('abc')]);
  });

  test('preserves the listed order — the picker is ranked by volume', () => {
    const want = [ip('3.3.3.3'), ip('1.1.1.1'), ip('2.2.2.2')];
    expect(newSubjects([], want)).toEqual(want);
  });

  test('everything already open yields nothing, so the keypress is a no-op', () => {
    expect(newSubjects([ip('1.1.1.1')], [ip('1.1.1.1')])).toEqual([]);
  });
});
