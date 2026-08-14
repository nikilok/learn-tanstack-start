// A tab bar that overflows its row makes Ink wrap it and the entire bar vanishes — the tabs still
// work, but nothing shows which one you are on.

import { describe, expect, test } from 'bun:test';

import { ARROW, tabWindow } from './useIpTabs';

const w = (n: number, each = 18) => Array.from({ length: n }, () => each);

describe('tabWindow', () => {
  test('everything shows when it fits, with no arrows', () => {
    expect(tabWindow(w(3), 0, 200)).toEqual({
      start: 0,
      end: 3,
      left: false,
      right: false,
    });
  });

  test('eight JA4 tabs in an 84-column pane are windowed, not dropped', () => {
    const r = tabWindow(w(8), 7, 84);
    expect(r.end - r.start).toBeGreaterThan(0);
    expect(r.end - r.start).toBeLessThan(8);
    expect(r.left).toBe(true);
  });

  test('the active tab is always inside the window', () => {
    for (const active of [0, 1, 3, 5, 7]) {
      const r = tabWindow(w(8), active, 84);
      expect(active).toBeGreaterThanOrEqual(r.start);
      expect(active).toBeLessThan(r.end);
    }
  });

  test('the window fits, except when even one tab cannot — then it keeps exactly one', () => {
    for (const avail of [20, 40, 84, 120]) {
      const r = tabWindow(w(8), 4, avail);
      const used = w(8)
        .slice(r.start, r.end)
        .reduce((a, b) => a + b, 0);
      // ARROW * 2 from the source, not a literal 4: both ends are budgeted for even when
      // only one arrow shows, so the window does not resize as it slides.
      const fits = used <= Math.max(0, avail - ARROW * 2);
      // The renderer clips an oversized lone chip; the window's job is never to return zero.
      expect(fits || r.end - r.start === 1).toBe(true);
      expect(r.end).toBeGreaterThan(r.start);
    }
  });

  // Live mode draws a '● ' marker before the chips. The caller must hand tabWindow the width that
  // is actually left, or the bar overflows by those two columns — and an overflow wraps, which
  // loses the entire bar rather than one chip.
  test('the window respects a width already spent on the live marker', () => {
    const LIVE_MARKER_W = 2;
    const widths = w(8);
    const avail = 84;
    const r = tabWindow(widths, 4, avail - LIVE_MARKER_W);
    const used = widths.slice(r.start, r.end).reduce((a, b) => a + b, 0);
    expect(used + LIVE_MARKER_W).toBeLessThanOrEqual(avail);
  });

  test('arrows mark exactly the ends that are cut off', () => {
    const first = tabWindow(w(8), 0, 84);
    expect(first.left).toBe(false);
    expect(first.right).toBe(true);
    const last = tabWindow(w(8), 7, 84);
    expect(last.left).toBe(true);
    expect(last.right).toBe(false);
  });

  test('a single tab too wide for the row still renders itself', () => {
    const r = tabWindow([60], 0, 20);
    expect(r.start).toBe(0);
    expect(r.end).toBe(1);
  });

  test('no tabs is not a crash', () => {
    expect(tabWindow([], 0, 80)).toEqual({
      start: 0,
      end: 0,
      left: false,
      right: false,
    });
  });

  test('an out-of-range active index is clamped rather than producing an empty window', () => {
    expect(tabWindow(w(3), 99, 20).end).toBeGreaterThan(0);
    expect(tabWindow(w(3), -1, 20).end).toBeGreaterThan(0);
  });
});
