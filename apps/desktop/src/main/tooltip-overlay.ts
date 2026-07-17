import { join } from 'node:path';

import { WebContentsView } from 'electron';

const TOOLTIP_W = 190;
const TOOLTIP_H = 104; // tall enough that the bubble's drop-shadow isn't clipped by the view
const CARET_OVERLAP = 6; // pull the view up a touch so its caret meets the bar
const MARGIN = 4; // keep the view off the window edge
const CARET_INSET = 16; // keep the caret clear of the view's corners

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

/** Sizes + positions the tooltip view under the hovered button (clamped to the window), shows it,
 * and returns where the caret must sit inside the view to still point at the button. */
export function positionTooltip(
  view: WebContentsView,
  barHeight: number,
  windowWidth: number,
  buttonX: number,
): number {
  const viewX = Math.round(
    Math.min(
      Math.max(buttonX - TOOLTIP_W / 2, MARGIN),
      windowWidth - TOOLTIP_W - MARGIN,
    ),
  );
  view.setBounds({
    x: viewX,
    y: barHeight - CARET_OVERLAP,
    width: TOOLTIP_W,
    height: TOOLTIP_H,
  });
  view.setVisible(true);
  return Math.min(
    Math.max(buttonX - viewX, CARET_INSET),
    TOOLTIP_W - CARET_INSET,
  );
}
