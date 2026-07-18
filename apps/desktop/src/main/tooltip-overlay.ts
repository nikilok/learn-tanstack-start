import { join } from 'node:path';

import { WebContentsView } from 'electron';

import { tooltipBounds } from './tooltip-geometry';

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
  const { caretX, ...bounds } = tooltipBounds(barHeight, windowWidth, buttonX);
  view.setBounds(bounds);
  view.setVisible(true);
  return caretX;
}
