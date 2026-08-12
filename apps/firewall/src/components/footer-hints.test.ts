// The footer bar's whole job is legibility: the key stands out, the label recedes, and a hint
// never breaks across a line with its key stranded. So the tone mapping and the wrap-row count
// are the things worth locking.

import { describe, expect, test } from 'bun:test';

import { hintRows, hintSegments } from './footer-hints';

const NB = ' ';

describe('hintSegments', () => {
  test('a key is the accent, its label is dim and joined by a non-breaking space', () => {
    expect(hintSegments([{ key: 'R', label: 'refresh' }])).toEqual([
      { text: 'R', tone: 'key' },
      { text: `${NB}refresh`, tone: 'dim' },
    ]);
  });

  test('spaces WITHIN a hint are non-breaking, so a multi-word hint cannot split', () => {
    // The terminal only breaks on ordinary spaces; a hint carries none, only the separators do.
    const [, label] = hintSegments([{ key: 'i', label: 'new ip' }]);
    expect(label.text).toBe(`${NB}new${NB}ip`);
    expect(label.text).not.toContain(' ');
  });

  test('hints are joined by a dim ordinary-space separator — the only break point', () => {
    const segs = hintSegments([
      { key: 'i', label: 'ip' },
      { key: 'f', label: 'ja4' },
    ]);
    expect(segs.map((s) => s.text)).toEqual([
      'i',
      `${NB}ip`,
      ' · ',
      'f',
      `${NB}ja4`,
    ]);
    expect(segs.find((s) => s.text === ' · ')?.tone).toBe('dim');
  });

  test('an active hint takes the green tone, not the accent — watch stays green when live', () => {
    const [k] = hintSegments([{ key: 'v', label: 'watch (on)', active: true }]);
    expect(k).toEqual({ text: 'v', tone: 'active' });
  });

  test('falsey hints are dropped, so conditional keys inline cleanly', () => {
    const segs = hintSegments([
      { key: 'v', label: 'watch' },
      false,
      null,
      undefined,
      { key: 'esc', label: 'rules' },
    ]);
    expect(segs.map((s) => s.text)).toEqual([
      'v',
      `${NB}watch`,
      ' · ',
      'esc',
      `${NB}rules`,
    ]);
  });

  test('empty in, empty out', () => {
    expect(hintSegments([])).toEqual([]);
    expect(hintSegments([false, null])).toEqual([]);
  });
});

describe('hintRows', () => {
  const hints = [
    { key: 'j/k', label: 'scroll' }, // 10
    { key: 'R', label: 'refresh' }, // 9
    { key: 'i', label: 'new ip' }, // 8
  ];

  test('everything on one line when it fits', () => {
    // 10 + 3 + 9 + 3 + 8 = 33
    expect(hintRows(hints, 40)).toBe(1);
    expect(hintRows(hints, 33)).toBe(1);
  });

  test('wraps at the separator, never mid-hint', () => {
    // 32 fits 'j/k scroll · R refresh' (22), then 'i new ip' drops to row 2.
    expect(hintRows(hints, 32)).toBe(2);
  });

  test('a leading prefix (a tab indicator) shares the first line', () => {
    // prefix 30 + would-be 33 overflows 40 immediately.
    expect(hintRows(hints, 40, 30)).toBe(2);
  });

  test('the first hint after a prefix adds NO separator — the prefix carries its own', () => {
    // 'j/k scroll' is 10 wide. After a 30-wide prefix that ends in its own ` · `, the composed
    // first line is prefix(30) + hint(10) = 40, which fits 42 on one row. Counting a phantom
    // separator (30 + 3 + 10 = 43) would wrap it to two — the off-by-one this guards.
    expect(hintRows([{ key: 'j/k', label: 'scroll' }], 42, 30)).toBe(1);
  });

  test('an empty list is zero rows, or one if only a prefix occupies it', () => {
    expect(hintRows([], 40)).toBe(0);
    expect(hintRows([false], 40)).toBe(0);
    expect(hintRows([], 40, 12)).toBe(1);
  });

  test('a non-positive width never divides by zero — it is a single row', () => {
    expect(hintRows(hints, 0)).toBe(1);
  });
});
