import { join } from 'node:path';

import { ipcMain, WebContentsView } from 'electron';
import type { BaseWindow, IpcMainEvent, Rectangle } from 'electron';

/**
 * If the splash never reports back — a renderer that failed to boot, or one killed
 * mid-fade — the view still has to go. Comfortably longer than the reveal and fade it is
 * waiting on, since overshooting here only delays a screen nobody can see.
 */
const FAILSAFE_MS = 2000;

export interface Splash {
  setBounds(bounds: Rectangle): void;
  /** Completes the reveal, fades out, and releases the view. Safe to call more than once. */
  dismiss(): void;
}

/**
 * The launch splash: the brand on the window's own background, painted before the site has
 * loaded anything at all.
 *
 * This exists because the web app's splash cannot serve the shell. That one is gated on
 * `display-mode: standalone` for installed PWAs, and a WebContentsView reports `browser`,
 * so it never rendered here. A local view is also the only version that can be up at frame
 * zero: it owes nothing to the network, which is the whole point of a splash.
 *
 * The renderer owns the timing of its own animation and reports when it has finished, so
 * those durations live in one place (SplashScreen.tsx) instead of being mirrored here.
 */
export function createSplash(parent: BaseWindow, bounds: Rectangle): Splash {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/titlebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Transparent, like the other local views: the ink is painted by the document, so fading
  // it out reveals the site underneath. A view background of its own would be what the
  // fade reveals instead — and the default is white, which is a flash on the way in.
  view.setBackgroundColor('#00000000');
  view.setBounds(bounds);
  if (process.env['ELECTRON_RENDERER_URL']) {
    void view.webContents.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}?role=splash`,
    );
  } else {
    void view.webContents.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { role: 'splash' },
    });
  }
  // Topmost: a launch splash covers the chrome as well as the page.
  parent.contentView.addChildView(view);

  let dismissed = false;
  let gone = false;

  /** Takes the view down. Reached from the renderer's report and from the failsafe. */
  function teardown(): void {
    if (gone) return;
    gone = true;
    ipcMain.removeListener('splash:done', onDone);
    if (parent.isDestroyed()) return;
    parent.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  function onDone(event: IpcMainEvent): void {
    if (event.sender === view.webContents) teardown();
  }
  ipcMain.on('splash:done', onDone);

  return {
    setBounds(next) {
      if (!gone) view.setBounds(next);
    },
    dismiss() {
      // Reachable from several directions at once (loaded, failed, and the failsafe), so
      // the second caller must be a no-op rather than a teardown of a released view.
      if (dismissed) return;
      dismissed = true;
      if (!view.webContents.isDestroyed()) {
        view.webContents.send('splash:dismiss');
      }
      const t = setTimeout(teardown, FAILSAFE_MS);
      t.unref?.(); // never hold the process open on the way out
    },
  };
}
