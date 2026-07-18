import { describe, expect, test } from 'bun:test';

import { tooltipBounds } from './tooltip-geometry.ts';

// Constants baked into tooltip-geometry: W=190, MARGIN=4, CARET_INSET=16, CARET_OVERLAP=6.
describe('tooltipBounds', () => {
  test('centers the view under a button with room on both sides', () => {
    const b = tooltipBounds(46, 1000, 500);
    expect(b.x).toBe(405); // 500 - 190/2
    expect(b.caretX).toBe(95); // caret dead-center of the 190-wide view
    expect(b.width).toBe(190);
    expect(b.height).toBe(104);
  });

  test('sits below the bar, lifted by CARET_OVERLAP', () => {
    expect(tooltipBounds(46, 1000, 500).y).toBe(40); // 46 - 6
    expect(tooltipBounds(60, 1000, 500).y).toBe(54);
  });

  test('clamps to the left margin; the caret follows to its inset', () => {
    const b = tooltipBounds(46, 1000, 20);
    expect(b.x).toBe(4); // MARGIN
    expect(b.caretX).toBe(16); // CARET_INSET
  });

  test('clamps to the right margin; the caret follows to its inset', () => {
    const b = tooltipBounds(46, 1000, 990);
    expect(b.x).toBe(806); // 1000 - 190 - 4
    expect(b.caretX).toBe(174); // 190 - 16
  });

  test('the caret always points at the button (clamped into the view corners)', () => {
    for (const buttonX of [0, 50, 200, 500, 800, 950, 1000]) {
      const b = tooltipBounds(46, 1000, buttonX);
      const caretAbsolute = b.x + b.caretX;
      const lo = b.x + 16; // CARET_INSET
      const hi = b.x + (190 - 16);
      expect(caretAbsolute).toBe(Math.min(Math.max(buttonX, lo), hi));
    }
  });

  test('the caret never escapes the view corners, even off-window', () => {
    for (const buttonX of [-100, 0, 500, 1000, 2000]) {
      const b = tooltipBounds(46, 1000, buttonX);
      expect(b.caretX).toBeGreaterThanOrEqual(16);
      expect(b.caretX).toBeLessThanOrEqual(174);
    }
  });
});
