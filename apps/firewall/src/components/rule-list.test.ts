// The rules column is the narrow one now, so a row must stay on one line at any width — a wrapped
// row pushes the list out of step with the cursor.

import { describe, expect, test } from 'bun:test';

import { rowWidths } from './rule-list';

const LONGEST = 28; // allow-desktop-release-record
const FIXED = 19;

describe('rowWidths', () => {
  test('a wide column shows the full name and spends the rest on the tail', () => {
    const w = rowWidths(120, LONGEST);
    expect(w.name).toBe(LONGEST);
    expect(w.tail).toBe(120 - FIXED - LONGEST);
  });

  test('at the 30% split the name still fits whole', () => {
    // 70/30 of a 200-col terminal leaves the rules column ~58.
    const w = rowWidths(58, LONGEST);
    expect(w.name).toBe(LONGEST);
    expect(w.tail).toBeGreaterThan(0);
  });

  test('a narrow column shrinks the name rather than wrapping', () => {
    const w = rowWidths(40, LONGEST);
    expect(w.name).toBeLessThan(LONGEST);
    expect(w.name + w.tail + FIXED).toBeLessThanOrEqual(40);
  });

  test('never negative, and never wider than the column', () => {
    for (const width of [0, 5, 19, 20, 34, 50, 80, 200]) {
      const w = rowWidths(width, LONGEST);
      expect(w.name).toBeGreaterThanOrEqual(0);
      expect(w.tail).toBeGreaterThanOrEqual(0);
      // The name floor can exceed a tiny column; the tail must then be zero, not negative.
      if (width >= 34) expect(w.name + w.tail + FIXED).toBeLessThanOrEqual(width);
    }
  });

  test('the tail is dropped before the name is starved', () => {
    const w = rowWidths(30, LONGEST);
    expect(w.tail).toBe(0);
    expect(w.name).toBeGreaterThanOrEqual(8);
  });

  test('a short longest-name does not pad the column out', () => {
    expect(rowWidths(120, 10).name).toBe(10);
  });
});
