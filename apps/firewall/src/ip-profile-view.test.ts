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

import { ageLabel } from './ip-profile-view';

describe('ageLabel', () => {
  const t0 = Date.parse('2026-08-04T12:00:00.000Z');
  const at = (secs: number) => ageLabel('2026-08-04T12:00:00.000Z', t0 + secs * 1000);

  test('a fresh snapshot reads as current', () => {
    expect(at(0)).toBe('just now');
    expect(at(30)).toBe('just now');
  });

  test('a stale one says how stale — a live window must not imply currency', () => {
    expect(at(300)).toBe('5m ago');
    expect(at(3600)).toBe('1h ago');
    expect(at(5400)).toBe('1h 30m ago');
  });

  test('a clock skewed backwards does not produce a negative age', () => {
    expect(at(-120)).toBe('just now');
  });
});
