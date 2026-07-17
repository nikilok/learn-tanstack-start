import { join } from 'node:path';

import { WebContentsView } from 'electron';

const TOOLTIP_W = 190;
const TOOLTIP_H = 104; // tall enough that the bubble's drop-shadow isn't clipped by the view
const CARET_OVERLAP = 6; // pull the view up a touch so its caret meets the bar

/** Creates the small, initially-hidden overlay view that renders the nav keycap tooltip below the arrows. */
export function createTooltipView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/titlebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  if (process.env['ELECTRON_RENDERER_URL']) {
    void view.webContents.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}?role=tooltip`,
    );
  } else {
    void view.webContents.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { role: 'tooltip' },
    });
  }
  return view;
}

/** Sizes + centers the tooltip view under the hovered arrow (clamped to the window) and shows it. */
export function positionNavTooltip(
  view: WebContentsView,
  barHeight: number,
  windowWidth: number,
  arrowX: number,
): void {
  const x = Math.round(
    Math.min(Math.max(arrowX - TOOLTIP_W / 2, 4), windowWidth - TOOLTIP_W - 4),
  );
  view.setBounds({
    x,
    y: barHeight - CARET_OVERLAP,
    width: TOOLTIP_W,
    height: TOOLTIP_H,
  });
  view.setVisible(true);
}
