import { join } from 'node:path';

import { net, WebContentsView } from 'electron';
import type { BaseWindow, Rectangle, WebContents } from 'electron';

import { probeDelayMs, probeStillDenied } from './block-detect';
import type { BlockReason } from './block-detect';

/** What the screen renders: why it is up, when the next check runs, whether one is in flight. */
export interface BlockState {
  reason: BlockReason;
  retryAt: number; // epoch ms
  checking: boolean;
}

export interface BlockedOverlayOptions {
  /** The window to mount into; null once it has been closed. */
  parent: () => BaseWindow | null;
  /** Where the child view sits (index 1 keeps it above the site, below the title bar). */
  index: number;
  /** Cheap URL to ask "are we being let through yet" — it must not be one the app hammers. */
  probeUrl: string;
  /** The site view's user-agent, so the check looks like the app rather than a stray client. */
  userAgent: () => string;
  /** The way back: called once the edge lets us through again. */
  onCleared: () => void;
  onShow: (reason: BlockReason) => void;
  onHide: () => void;
}

export interface BlockedOverlay {
  show(reason: BlockReason): void;
  hide(): void;
  /** Check again now, on the user's say-so. */
  retry(): void;
  isUp(): boolean;
  /** Why the screen is up, or null when it is not. */
  reason(): BlockReason | null;
  /** Hands keyboard focus to the screen, so its controls answer the keyboard. */
  focus(): void;
  setBounds(bounds: Rectangle): void;
  /** Pushes the current state to a renderer reporting ready; no-op for any other view. */
  sendStateTo(wc: WebContents): void;
  sendTheme(payload: { dark: boolean; mode: string }): void;
  destroy(): void;
}

/**
 * The local stand-in for the site: a full-window view, created on first need, that covers
 * the page whenever it cannot be reached or served. Everything it renders is bundled, so
 * it stands up with no network at all — and it owns the way back, checking on its own
 * schedule and reloading the moment the site answers again.
 */
export function createBlockedOverlay(
  opts: BlockedOverlayOptions,
): BlockedOverlay {
  let view: WebContentsView | null = null;
  let bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  let state: BlockState | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Builds the view on first need — most sessions never see this screen. */
  function ensureView(): WebContentsView | null {
    if (view) return view;
    const parent = opts.parent();
    if (!parent || parent.isDestroyed()) return null;
    const v = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/titlebar.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    v.setBounds(bounds);
    if (process.env['ELECTRON_RENDERER_URL']) {
      void v.webContents.loadURL(
        `${process.env['ELECTRON_RENDERER_URL']}?role=blocked`,
      );
    } else {
      void v.webContents.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { role: 'blocked' },
      });
    }
    parent.contentView.addChildView(v, opts.index);
    view = v;
    return v;
  }

  function push(): void {
    if (!view || view.webContents.isDestroyed()) return;
    view.webContents.send('blocked:state', state);
  }

  function scheduleProbe(): void {
    if (timer) clearTimeout(timer);
    if (!state) return;
    const delay = probeDelayMs(state.reason, attempt);
    state = { ...state, retryAt: Date.now() + delay, checking: false };
    push();
    timer = setTimeout(() => void runProbe(), delay);
  }

  /** One request. null means the site is answering again; anything else is why it still is not. */
  async function probe(): Promise<BlockReason | null> {
    try {
      const res = await net.fetch(opts.probeUrl, {
        method: 'HEAD',
        cache: 'no-store',
        headers: { 'User-Agent': opts.userAgent() },
      });
      return probeStillDenied(res.status, res.headers.get('x-vercel-mitigated'))
        ? 'blocked'
        : null;
    } catch {
      return net.isOnline() ? 'unreachable' : 'offline'; // no answer at all
    }
  }

  async function runProbe(): Promise<void> {
    if (!state) return;
    state = { ...state, checking: true };
    push();
    const reason = await probe();
    if (!state) return; // hidden while the request was in flight
    if (!reason) {
      hide();
      opts.onCleared();
      return;
    }
    if (reason === state.reason) {
      attempt += 1;
    } else {
      // It changed under us (a refusal became an outage, or the other way round): say so,
      // and start that reason's schedule from the top rather than inheriting a long wait.
      attempt = 0;
      state = { ...state, reason };
      opts.onShow(reason);
    }
    scheduleProbe();
  }

  function hide(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!state) return;
    state = null;
    push();
    view?.setVisible(false);
    opts.onHide();
  }

  return {
    show(reason) {
      // Every refused request re-reports while the screen is up; the first one owns the
      // schedule, or the countdown would restart on each one and never reach a check.
      if (state?.reason === reason) return;
      const v = ensureView();
      if (!v) return;
      v.setBounds(bounds);
      v.setVisible(true);
      v.webContents.focus();
      attempt = 0;
      state = { reason, retryAt: Date.now(), checking: false };
      opts.onShow(reason);
      scheduleProbe();
    },
    hide,
    retry() {
      if (!state || state.checking) return;
      if (timer) clearTimeout(timer);
      timer = null;
      void runProbe();
    },
    isUp: () => state !== null,
    reason: () => state?.reason ?? null,
    focus() {
      if (view && !view.webContents.isDestroyed()) view.webContents.focus();
    },
    setBounds(next) {
      bounds = next;
      view?.setBounds(next);
    },
    sendStateTo(wc) {
      if (wc === view?.webContents) wc.send('blocked:state', state);
    },
    sendTheme(payload) {
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.send('titlebar:theme', payload);
      }
    },
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
      state = null;
      view = null;
    },
  };
}
