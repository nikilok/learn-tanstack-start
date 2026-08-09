import { join } from 'node:path';

import { ipcMain, WebContentsView } from 'electron';
import type { BaseWindow, IpcMainEvent, Rectangle } from 'electron';

/**
 * If the splash never reports back — a renderer that failed to boot, or one killed
 * mid-fade — the view still has to go. Comfortably longer than the reveal and fade it is
 * waiting on, since overshooting here only delays a screen nobody can see.
 */
const FAILSAFE_MS = 2000;

/**
 * How long the splash stays up once it is actually on screen, however quickly the app turns
 * out to be ready. Measured from the moment the window is shown for it, not from launch:
 * everything before that is a hidden window, and counting it would be counting time nobody
 * saw. The renderer's own finish and fade (~420ms) run after this, so a launch with nothing
 * to wait for still spends about a second on the brand rather than blinking past it.
 */
const MIN_VISIBLE_MS = 800;

export interface Splash {
  /** True once the splash has reported a painted frame; the window is shown on that. */
  hasPainted(): boolean;
  /** Puts it in the window, on top of everything already there. */
  mount(parent: BaseWindow): void;
  setBounds(bounds: Rectangle): void;
  /** Completes the reveal, fades out, and releases the view. Safe to call more than once. */
  dismiss(): void;
  /** Drops it immediately, listener and all — for a window closed before it ever finished. */
  destroy(): void;
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
 *
 * Built and started BEFORE the window's other views, and mounted afterwards. Spinning up a
 * renderer process is most of the wait before anything can paint — measured at ~890ms just
 * to fetch a local file — and going last meant queueing behind three other views for it.
 * `onReady` fires once the renderer reports itself mounted, which is the cue to show the
 * window: the chrome and the splash then arrive together instead of a bare rectangle
 * sitting there first.
 */
export function createSplash(
  bounds: Rectangle,
  dark: boolean,
  onReady: () => void,
): Splash {
  let parent: BaseWindow | null = null;
  // On the URL rather than over IPC: the renderer needs it for its very first paint, and
  // a message could not arrive before one.
  const theme = dark ? 'dark' : 'light';
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
      `${process.env['ELECTRON_RENDERER_URL']}?role=splash&theme=${theme}`,
    );
  } else {
    void view.webContents.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { role: 'splash', theme },
    });
  }
  let dismissed = false;
  let gone = false;
  let announced = false;
  /** When this splash actually became visible, which is when the window was shown for it. */
  let shownAt: number | null = null;

  /**
   * The window is shown on the splash's first PAINTED frame, not on `dom-ready`. dom-ready
   * only means the document parsed: the renderer still has to mount and lay out, and
   * showing the window on it opened an empty rectangle that sat there for as long as that
   * took — which is the blank window a launch with no network used to start with.
   *
   * It also means the renderer has subscribed, since it reports this after wiring its
   * dismiss listener — so nothing sent from here can land in a document with nobody home.
   */
  function onPainted(event: IpcMainEvent): void {
    if (event.sender !== view.webContents || announced) return;
    announced = true;
    shownAt = Date.now();
    ipcMain.removeListener('splash:painted', onPainted);
    onReady();
    // Asked to go before it was even up: start its minimum now that the clock has one.
    if (dismissed) startLeaving();
  }
  ipcMain.on('splash:painted', onPainted);

  /**
   * Tells the renderer to go, once this splash has had its minimum time on screen. An app
   * that is ready immediately — the local dev server, a warm cache — used to dismiss it on
   * the same frame it appeared, which read as no splash at all. A launch that takes any
   * real time is long past the floor and is not delayed by it.
   */
  function startLeaving(): void {
    if (gone || shownAt === null) return; // not visible yet; onPainted comes back to this
    const left = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
    const t = setTimeout(sendDismiss, left);
    t.unref?.();
  }

  /** Tells the renderer to finish its reveal and fade; it reports back when it has. */
  function sendDismiss(): void {
    if (!view.webContents.isDestroyed()) {
      view.webContents.send('splash:dismiss');
    }
  }

  /** Takes the view down. Reached from the renderer's report and from the failsafe. */
  function teardown(): void {
    if (gone) return;
    gone = true;
    ipcMain.removeListener('splash:done', onDone);
    ipcMain.removeListener('splash:painted', onPainted);
    // The renderer is released whether or not the window is still there. Returning early
    // on a destroyed parent would leave the process resident for the life of the app.
    if (parent && !parent.isDestroyed())
      parent.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  function onDone(event: IpcMainEvent): void {
    if (event.sender === view.webContents) teardown();
  }
  ipcMain.on('splash:done', onDone);

  return {
    mount(win) {
      if (gone || win.isDestroyed()) return;
      parent = win;
      // Added last, so a launch splash covers the chrome as well as the page.
      win.contentView.addChildView(view);
    },
    hasPainted: () => announced,
    setBounds(next) {
      if (!gone) view.setBounds(next);
    },
    dismiss() {
      // Reachable from several directions at once (loaded, failed, and the failsafe), so
      // the second caller must be a no-op rather than a teardown of a released view.
      if (dismissed) return;
      dismissed = true;
      startLeaving();
      // Armed here rather than after the minimum, so a renderer that never came up — and
      // so never reports painted, never leaves, and never reports done — cannot leave this
      // view sitting over the app for good.
      const t = setTimeout(teardown, MIN_VISIBLE_MS + FAILSAFE_MS);
      t.unref?.(); // never hold the process open on the way out
    },
    destroy: teardown,
  };
}
