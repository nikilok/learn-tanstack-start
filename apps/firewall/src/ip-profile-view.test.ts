import { describe, expect, test } from 'bun:test';

import { barWidth } from './ip-profile-view';

describe('barWidth', () => {
  test('scales with the pane so a wide split is actually used', () => {
    expect(barWidth(140)).toBeGreaterThan(barWidth(60));
  });

  test('never collapses to nothing in a narrow pane', () => {
    expect(barWidth(30)).toBeGreaterThanOrEqual(20);
    expect(barWidth(0)).toBeGreaterThanOrEqual(20);
  });

  test('caps out, since past a point longer bars stop being comparable', () => {
    expect(barWidth(400)).toBe(barWidth(1000));
  });

  test('leaves room for the stamp and count columns', () => {
    // The bar starts ~26 cols in; it must not push the line past the pane.
    for (const w of [60, 100, 140]) expect(barWidth(w) + 26).toBeLessThanOrEqual(w);
  });
});
