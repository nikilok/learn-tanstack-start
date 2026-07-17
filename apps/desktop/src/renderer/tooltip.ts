import type { MouseEvent } from 'react';

/** onMouseEnter handler: tells main which button (by kind) is hovered and its centre x. */
export function tooltipHover(kind: TooltipKind) {
  return (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    window.titlebar.showTooltip({ kind, x: Math.round(r.left + r.width / 2) });
  };
}

/** onMouseLeave handler for a button cluster — hides the tooltip. */
export const tooltipLeave = (): void => window.titlebar.showTooltip(null);
