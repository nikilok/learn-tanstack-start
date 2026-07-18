/**
 * Pure geometry for the nav keycap tooltip overlay — where its small view sits
 * (clamped to the window) and where the caret must point. Electron-free so it's
 * unit-testable; tooltip-overlay.ts applies the result to the WebContentsView.
 */

const TOOLTIP_W = 190;
const TOOLTIP_H = 104; // tall enough that the bubble's drop-shadow isn't clipped by the view
const CARET_OVERLAP = 6; // pull the view up a touch so its caret meets the bar
const MARGIN = 4; // keep the view off the window edge
const CARET_INSET = 16; // keep the caret clear of the view's corners

export interface TooltipBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  caretX: number; // where the caret sits inside the view to still point at the button
}

/** Sizes + positions the tooltip view under the hovered button, clamped to the window, and computes where the caret must sit inside the view to keep pointing at the button. */
export function tooltipBounds(
  barHeight: number,
  windowWidth: number,
  buttonX: number,
): TooltipBounds {
  const x = Math.round(
    Math.min(
      Math.max(buttonX - TOOLTIP_W / 2, MARGIN),
      windowWidth - TOOLTIP_W - MARGIN,
    ),
  );
  const caretX = Math.min(
    Math.max(buttonX - x, CARET_INSET),
    TOOLTIP_W - CARET_INSET,
  );
  return {
    x,
    y: barHeight - CARET_OVERLAP,
    width: TOOLTIP_W,
    height: TOOLTIP_H,
    caretX,
  };
}
