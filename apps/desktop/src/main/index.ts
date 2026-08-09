import { join } from 'node:path';

import {
  app,
  BaseWindow,
  clipboard,
  ipcMain,
  nativeTheme,
  net,
  session,
  shell,
  WebContentsView,
} from 'electron';

import {
  isEdgeDenied,
  isMissingApp,
  isServerError,
  simulatedReason,
} from './block-detect';
import type { BlockReason } from './block-detect';
import { createBlockedOverlay } from './blocked-overlay';
import type { BlockedOverlay } from './blocked-overlay';
import { registerKeyboardShortcuts } from './keyboard-shortcuts';
import { setupMenu } from './menu';
import { cleanTitle, desktopUserAgent } from './site';
import { createSplash } from './splash';
import { parseThemeMode, splashIsDark } from './theme-mode';
import type { ThemeMode } from './theme-mode';
import { readSavedThemeMode, saveThemeMode } from './theme-store';
import { createTooltipView, positionTooltip } from './tooltip-overlay';
import {
  getPendingUpdate,
  initAutoUpdates,
  installPendingUpdate,
} from './updater';

const isDev = !app.isPackaged;
// Dev points at the local web server so web-app changes show live; packaged builds use
// production. DESKTOP_APP_URL overrides either.
const APP_URL =
  process.env.DESKTOP_APP_URL ??
  (isDev ? 'https://web.local' : 'https://sponsorsearch.co.uk');
const APP_ORIGIN = new URL(APP_URL).origin;

// web.local serves a self-signed (portless) cert Chromium won't trust — accept it for
// the dev origin only, and only when unpackaged. Never relax certs in a packaged build.
if (isDev) {
  app.on(
    'certificate-error',
    (event, _webContents, url, _error, _cert, callback) => {
      if (new URL(url).origin === APP_ORIGIN) {
        event.preventDefault();
        callback(true);
      } else {
        callback(false);
      }
    },
  );
}
// The custom title bar floats as a transparent overlay over the top of the full-height
// site view, so the page's own background shows through and it reads as one surface.
// The page reserves NO top space — content scrolls under the (drag-region) bar; static
// top content clears it via its own padding, and styles.css pins the desktop search
// pill at this same offset (html[data-desktop] .site-header) — keep the two in sync.
const TITLEBAR_HEIGHT = 46;
// The site's own page colours (--bg-page-edge), so the window, the splash drawn over it and
// the app that follows are one continuous surface — the splash paints a moment after the
// window appears, and any difference here would read as a flash between the two. Which one
// is chosen comes from the theme the shell remembered; see splashDark().
const INITIAL_BG = { dark: '#0a0a0a', light: '#f4f4f8' };

/**
 * How long the launch splash will wait for the stand-in screen to paint before handing over
 * anyway. Generous on purpose: this screen's renderer shares a process — and therefore a
 * main thread — with the splash, the title bar and the tooltip, and measured cold it needs
 * ~2.5s from creation to having its state and a frame up. A backstop that fires at the same
 * moment the real signal lands is a race, and losing it means handing over to a screen that
 * is not there yet. It exists only so a renderer that never comes up cannot hold a splash
 * over a dead window for good.
 */
const BLOCKED_PAINT_MS = 5000;

/**
 * And how long the stand-in screen keeps covering the window on the way back, waiting for
 * the returning page to paint. Matches the launch backstop: it is the same page load.
 */
const SITE_RETURN_MS = 6000;

/**
 * How long a first load may sit there saying nothing before the shell stops waiting on it
 * and puts the stand-in screen up instead. Chosen to sit above a genuinely slow cold load
 * and below Chromium's own patience with a dead host (~10.4s to ERR_FAILED on a hostname
 * that accepts nothing, measured) — waiting for that is four seconds of nothing to look at.
 * Overshooting only costs a longer splash, which is the thing a splash is for.
 */
const SLOW_LOAD_MS = 8000;

// What the title-bar pill reads while the stand-in screen is up; the page's own title
// behind it is either stale or the refusal's, and neither says anything useful.
const BLOCK_TITLES: Record<BlockReason, string> = {
  blocked: 'Too many requests',
  offline: 'Offline',
  unreachable: 'Cannot reach SponsorSearch',
};

let mainWindow: BaseWindow | null = null;
let titleBarView: WebContentsView | null = null;
let siteView: WebContentsView | null = null;
let tooltipView: WebContentsView | null = null;
let blocked: BlockedOverlay | null = null;
let lastTarget = APP_URL; // the page to come back to once the site answers again
let lastDark = true;
let lastCursorOn = true; // custom-cursor on/off, mirrored to the title bar
let lastFilterCount = 0; // active filters, badged on the title-bar icon
let lastMode: ThemeMode = 'auto'; // theme mode, for the title bar icon and next launch
let screenSaverOn = false; // the web app's screensaver has the window

/**
 * Which theme the window and its splash open on, before the page exists to report one.
 * The remembered choice decides it, and `auto` (or a first-ever launch) defers to the OS
 * the same way the web app's own default does.
 */
function splashDark(): boolean {
  return splashIsDark(readSavedThemeMode(), nativeTheme.shouldUseDarkColors);
}

/**
 * Dev affordance: DESKTOP_SIMULATE_RATE_LIMIT / _OFFLINE / _UNREACHABLE put the stand-in
 * screen up at launch. Offline in particular needs the machine's network genuinely gone to
 * reproduce, and the dev site is served over loopback, so pulling the network does not even
 * take it down.
 *
 * It seeds the state and nothing else: every check from there is a real one, so the
 * countdown reconnects and hands the window back exactly as it does in the wild. Faking the
 * checks too made the screen sit there through a countdown that never did anything.
 */
function simulatedBlock(): BlockReason | null {
  return app.isPackaged ? null : simulatedReason(process.env);
}

/** The title-bar pill's text: what the stand-in screen is saying, or the page's own title. */
function currentTitle(): string {
  const reason = blocked?.reason();
  return reason
    ? BLOCK_TITLES[reason]
    : (siteView?.webContents.getTitle() ?? '');
}

/** True when a #rrggbb colour is dark enough to want light foreground text. */
function isDarkColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** Sends any off-origin http(s) link to the user's default browser. */
function openExternal(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

/** Pushes the site's back/forward availability to the title bar buttons. */
function pushNavState(): void {
  // Greyed out while the stand-in screen is up: the history is still there, but moving
  // through it only earns another refusal.
  const h = blocked?.isUp() ? null : siteView?.webContents.navigationHistory;
  titleBarView?.webContents.send('titlebar:navstate', {
    canGoBack: h?.canGoBack() ?? false,
    canGoForward: h?.canGoForward() ?? false,
  });
}

/** Drives the site view's history back/forward, then hands keyboard focus back to the page. */
function navigate(dir: 'back' | 'forward'): void {
  // Shortcuts reach here via before-input-event, which preventDefaults them — so the page
  // never sees the keystroke and would stay idle while the shell acts on it.
  reportChromeInput(true);
  if (blocked?.isUp()) return;
  const h = siteView?.webContents.navigationHistory;
  if (!h) return;
  if (dir === 'back' && h.canGoBack()) h.goBack();
  else if (dir === 'forward' && h.canGoForward()) h.goForward();
  siteView?.webContents.focus();
}

/** Forwards a title-bar command to the web app (its DesktopBridge handles share / cursor / theme / home). */
function sendCommand(cmd: string): void {
  reportChromeInput(true); // see navigate(): shortcuts never reach the page as keystrokes
  // Anything that would move the page is dropped while the stand-in screen is up. The rest
  // is forwarded, but only the page can act on it — on a cold-start block there is no app
  // document behind the screen, so those buttons genuinely do nothing until it clears.
  if (blocked?.isUp() && (cmd === 'home' || cmd === 'filters')) return;
  siteView?.webContents.send('ss:command', cmd);
  // Navigation commands hand focus to the page (type-to-search, form controls).
  if (cmd === 'home' || cmd === 'filters') siteView?.webContents.focus();
}

// Input on the chrome that counts as a deliberate gesture rather than the pointer merely
// passing over it. Anything not listed here is treated as movement: it keeps the page from
// going idle, but it must not dismiss a running screensaver, or a mouse resting in the
// title-bar strip would wake it on a pixel of drift — the very thing `isWakeMove` filters
// out inside the page. Unknown future types fall to the safe side (movement).
const DELIBERATE_INPUT = new Set([
  'mouseDown',
  'mouseUp',
  'mouseWheel',
  'contextMenu',
  'keyDown',
  'rawKeyDown',
  'char',
]);

/**
 * Tells the page the shell handled input on its behalf. The title bar is a separate view
 * and main swallows the app's shortcuts before they reach the renderer, so without this
 * the page counts a user working entirely in the chrome as idle.
 */
function reportChromeInput(deliberate: boolean): void {
  const wc = siteView?.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send('ss:chrome-input', deliberate);
}

/**
 * Fades the chrome out of the way of the page's screensaver, and back in when it lifts.
 * The bar floats over a full-height site view, so it would otherwise sit on top of the
 * screensaver; macOS's traffic lights are drawn by the OS, not by that view.
 */
function setScreenSaver(on: boolean): void {
  screenSaverOn = on;
  // Reachable while the window is being torn down (the site view's render-process-gone
  // handler calls this), so check before touching either object.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (titleBarView && !titleBarView.webContents.isDestroyed()) {
    titleBarView.webContents.send('titlebar:screensaver', on);
  }
  if (on) tooltipView?.setVisible(false);
  if (process.platform === 'darwin') {
    mainWindow.setWindowButtonVisibility(!on);
  }
}

/** Sends the current page title (cleaned) to the title bar pill. */
function pushTitle(title: string): void {
  titleBarView?.webContents.send('titlebar:title', cleanTitle(title));
}

/** Pushes the current theme to every local view — the bar, the tooltip, the stand-in screen. */
function broadcastTheme(): void {
  const payload = { dark: lastDark, mode: lastMode };
  titleBarView?.webContents.send('titlebar:theme', payload);
  tooltipView?.webContents.send('titlebar:theme', payload);
  blocked?.sendTheme(payload);
}

/** Creates the window: a custom title-bar view above a WebContentsView of the hosted site. */
function createWindow(): void {
  const isMac = process.platform === 'darwin';
  // Resolved once per window: the splash, the window and the site view all open on it, and
  // reading it twice could straddle an OS appearance change mid-launch.
  const openDark = splashDark();
  const openBg = openDark ? INITIAL_BG.dark : INITIAL_BG.light;
  lastDark = openDark; // until the page reports its own
  // And the mode alongside it, or the title bar's control opens on `auto` whatever the
  // user last chose — for the whole session on a launch where the page never loads.
  lastMode = readSavedThemeMode() ?? 'auto';

  // Started before anything else in the window, so its renderer process is not queued
  // behind the site view's and the chrome's — that queue was the whole delay before the
  // splash could paint. It is mounted further down, after the views it has to cover.
  let showWindow = (): void => {};
  const splash = createSplash(
    { x: 0, y: 0, width: 1280, height: 860 },
    openDark,
    () => showWindow(),
  );

  const win = new BaseWindow({
    width: 1280,
    height: 860,
    // Floor: the logo/nav and utility clusters collide below ~515; 600 keeps a gap for the centered title and still allows half-screen tiling on 1280/1440 laptops.
    minWidth: 600,
    minHeight: 480,
    show: false,
    backgroundColor: openBg,
    // macOS keeps the native traffic lights (inset into the logo pill); Windows/Linux are
    // frameless and draw their own min/max/close in the title bar (see WindowControls).
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 34, y: 16 }, // macOS only; ignored elsewhere
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      titleBarView = null;
      siteView = null;
      tooltipView = null;
      blocked?.destroy();
      blocked = null;
      // A window closed mid-launch would otherwise leave the splash's ipcMain listener and
      // its renderer behind — one of each per open/close cycle.
      splash.destroy();
      screenSaverOn = false;
    }
  });
  // Keep the custom maximise/restore icon (Windows/Linux) in sync with the window state.
  const sendMaximized = (): void => {
    titleBarView?.webContents.send('titlebar:maximized', win.isMaximized());
  };
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);

  // The hosted site fills the whole window; the transparent title bar floats over its top
  // so the page's own background (grid + glow) shows through as one seamless surface.
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.setBackgroundColor(openBg);
  siteView = view;

  // Title bar (custom chrome): a transparent overlay. Its page body and view background
  // are both clear, so only the buttons + centered title paint and the site shows behind.
  const bar = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/titlebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  bar.setBackgroundColor('#00000000');
  if (process.env['ELECTRON_RENDERER_URL']) {
    void bar.webContents.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void bar.webContents.loadFile(join(__dirname, '../renderer/index.html'));
  }
  titleBarView = bar;

  // The bar is its own view, so input landing on it never reaches the page. Forward it
  // ALWAYS, not just while the screensaver is up: someone navigating purely from the
  // chrome is present, and the page would otherwise count them idle and dissolve the app
  // out from under them mid-use.
  bar.webContents.on('input-event', (_event, input) => {
    reportChromeInput(DELIBERATE_INPUT.has(input.type));
  });
  // The page owns the screensaver state, so a dead renderer would otherwise leave the
  // chrome (window buttons included) hidden with nothing left able to hand it back.
  view.webContents.on('render-process-gone', () => setScreenSaver(false));

  win.contentView.addChildView(view); // site fills the window, behind…
  win.contentView.addChildView(bar); // …the transparent title bar on top

  // A tiny, initially-hidden overlay above everything, positioned per-hover to show the
  // nav keycap tooltip below the arrows (the 46px bar would otherwise clip it).
  const tip = createTooltipView();
  win.contentView.addChildView(tip);
  tooltipView = tip;

  // The local stand-in for the site. Built on first need and mounted between the page and
  // the title bar, so the bar keeps floating over it exactly as it does over the page.
  blocked = createBlockedOverlay({
    parent: () => mainWindow,
    index: 1,
    probeUrl: APP_URL,
    userAgent: () => view.webContents.getUserAgent(),
    onCleared: (sitePainted) => {
      if (view.webContents.isDestroyed()) {
        sitePainted();
        return;
      }
      // The mirror of the launch gate: the stand-in screen keeps covering the window until
      // the page it is handing back to has painted, so recovery does not flash a blank
      // window for the length of the reload.
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        view.webContents.removeListener('dom-ready', settle);
        sitePainted();
        // The screen held focus the whole time it was up; without handing it back, the
        // page returns with every keybinding dead until the user clicks it. Via
        // focusForeground, because a refusal may have cancelled the hand-back while this
        // was pending — focusing the page unconditionally then left the stand-in screen on
        // screen with a dead keyboard and no way to reach its retry.
        focusForeground();
      };
      // A load that neither finishes nor fails must not leave the screen covering a live
      // page forever — but nor may it uncover one that has painted nothing, which is the
      // same rule the launch path follows. So the backstop puts the screen back up rather
      // than handing over: `show` cancels the hand-back and re-arms the schedule, and the
      // `settle` that follows then finds nothing to hand back and does nothing.
      const backstop = setTimeout(() => {
        blocked?.show('unreachable');
        settle();
      }, SITE_RETURN_MS);
      backstop.unref?.();
      view.webContents.once('dom-ready', settle);
      void view.webContents.loadURL(lastTarget);
    },
    onShow: (reason) => {
      // The page owns the screensaver, and it would otherwise sit over this.
      setScreenSaver(false);
      pushNavState();
      pushTitle(BLOCK_TITLES[reason]);
    },
    onHide: () => {
      pushNavState();
      pushTitle(currentTitle());
    },
    background: () => (lastDark ? INITIAL_BG.dark : INITIAL_BG.light),
    // Shortcuts are bound per webContents, so a view that can hold focus has to be bound
    // too — otherwise every one of them dies while this screen is the focused view.
    onCreated: (v) =>
      registerKeyboardShortcuts([v.webContents], {
        navigate,
        command: sendCommand,
      }),
  });

  // Mounted last so it covers the page and the chrome both — see splash.ts for why the web
  // app's own splash cannot serve this.
  splash.mount(win);

  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
    blocked?.setBounds({ x: 0, y: 0, width, height });
    bar.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
    splash.setBounds({ x: 0, y: 0, width, height });
    tip.setVisible(false); // stale on resize; the next hover re-positions + shows it
  };
  layout();
  win.on('resize', layout);

  // Shown once the splash has actually painted, so the window arrives with the brand on it
  // rather than as a bare rectangle that fills in a beat later. Spawning the first renderer
  // process is most of that wait (~900ms measured, and unavoidable — it is what Chromium
  // costs to start), and mounting is more on top, so the backstop sits well clear of both:
  // its only job is to make sure a splash that never paints cannot keep the window off
  // screen entirely. Better a late window than a blank one — nothing is lost by waiting,
  // since there is nothing behind it to look at yet, and in dev the renderer comes off a
  // Vite server rather than disk and does not mount until ~3s.
  let shown = false;
  showWindow = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  setTimeout(showWindow, 4000).unref?.();

  const simulated = simulatedBlock();
  if (simulated) blocked.show(simulated);

  const wc = view.webContents;
  wc.setUserAgent(
    desktopUserAgent(wc.getUserAgent(), app.getName(), app.getVersion()),
  );

  // Same-origin navigation stays in-app; everything else opens in the browser.
  wc.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      event.preventDefault();
      openExternal(url);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-navigate', (_e, url) => {
    lastTarget = url || lastTarget;
    pushNavState();
  });
  // isMainFrame matters here and not on `did-navigate`: this event also fires for
  // subframes, and the app iframes itself on /download — a route change inside that demo
  // would otherwise become the page the shell returns to after a block.
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    lastTarget = url || lastTarget;
    pushNavState();
  });
  wc.on('page-title-updated', (_e, title) => {
    if (!blocked?.isUp()) pushTitle(title);
  });

  // The handover from the splash to whatever is going to be on screen. Declared here
  // because the refusal watcher below also has to be able to call it.
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let revealed = false;
  // Per window: once the app has served one document here, a later 404 is its own page.
  let appHasServed = false;

  /**
   * Keyboard focus goes to the view in front — the site (not the title bar), so typing
   * reaches the page right away, since the web app's type-to-search needs the document
   * focused; or the stand-in screen when that is what is covering it, or the keyboard
   * would land on the page underneath.
   */
  const focusForeground = (): void => {
    if (win.isDestroyed()) return;
    if (blocked?.isUp()) blocked.focus();
    else wc.focus();
  };

  const finishReveal = (): void => {
    if (revealed) return;
    revealed = true;
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
    if (win.isDestroyed()) return; // timer/load may fire after a fast window close
    // Whatever is going to be on screen is ready, so the window may as well be up: without
    // this its only other triggers are the splash's own mount report and the backstop, and
    // a splash that never reports would keep a perfectly loaded app hidden until then.
    showWindow();
    splash.dismiss();
    focusForeground();
  };

  /**
   * The splash is the gate: it comes down only once there is something painted behind it.
   * That is either the site, or — when the site is refused, offline or simply not there —
   * the stand-in screen, whose renderer takes a moment to boot and then renders nothing
   * until its state arrives. Dropping the splash the instant that screen was *asked* for
   * left the window empty for both of those waits, which is the gap this closes. The
   * reason does not matter: rate limit, outage or no network all hand over the same way.
   */
  const reveal = (): void => {
    if (revealed) {
      focusForeground(); // a later refusal still has to move the keyboard
      return;
    }
    if (win.isDestroyed()) return;
    if (blocked?.isUp()) blocked.whenPainted(finishReveal, BLOCKED_PAINT_MS);
    else finishReveal();
  };

  // Neither of these is something the page can report. A refusal happens at the network
  // layer; a 5xx document is a complete, successful load of somebody else's error page, so
  // there is no failure event anywhere in the shell to hang off. Watching the responses
  // catches both, on the document and on the RPCs a loaded page fires in the background —
  // the case that would otherwise just look like a broken app.
  wc.session.webRequest.onCompleted(
    { urls: [`${APP_ORIGIN}/*`] },
    (details) => {
      // The session outlives the window, so a request can still land during teardown.
      // `isUp()` stays true right through the hand-back — the state is only cleared once
      // the returning page has painted — so guarding on it alone made this blind to a
      // refusal on the recovery navigation itself, which is the most likely place to hit
      // one. `show()` is what decides whether a repeat is worth acting on.
      if (wc.isDestroyed()) return;
      // Proof that the app itself can serve a document. Until it has, a 404 is the proxy
      // or the platform saying it has never heard of us rather than the app saying a page
      // is gone — see isMissingApp.
      if (details.resourceType === 'mainFrame' && details.statusCode < 400) {
        appHasServed = true;
      }
      if (blocked?.isUp() && !blocked.handingBack()) return;
      const reason = isEdgeDenied(details)
        ? 'blocked'
        : isServerError(details) || isMissingApp(details, appHasServed)
          ? 'unreachable'
          : null;
      if (!reason) return;
      blocked?.show(reason);
      if (!blocked?.isUp()) return;
      wc.stop(); // the rest in flight is only going to be refused too
      // stop() aborts the document mid-load, so dom-ready and did-finish-load may never
      // arrive and the resulting did-fail-load is an ABORTED the handler skips. On a
      // launch that is refused outright this is the only reveal that ever runs, and it
      // hands over to the stand-in screen the moment that screen has painted.
      reveal();
    },
  );

  // Cmd/Ctrl + [ / ] back / forward, whichever view holds focus (see keyboard-shortcuts.ts).
  registerKeyboardShortcuts([wc, bar.webContents], {
    navigate,
    command: sendCommand,
  });

  // A slow load keeps the splash, which is what it is for. A load that never finishes and
  // never fails must not keep it forever, though: the splash is above the title bar, so
  // the custom window controls on Windows and Linux are underneath it until this fires.
  //
  // What it must NOT do is lift onto a page that has produced nothing. Chromium is slow to
  // give up on a host that accepts nothing — web.local with the dev server down takes
  // ~10.4s to report ERR_FAILED, measured — so this used to uncover an empty site view
  // seconds before the failure arrived, which is exactly the black screen between the
  // splash and the game. If it fires with nothing behind it, the stand-in screen goes up
  // first and the splash hands over to that; its probe owns the recovery, and a site that
  // turns out to be fine is picked up on the next check.
  revealTimer = setTimeout(() => {
    if (!revealed && !blocked?.isUp()) blocked?.show('unreachable');
    reveal();
  }, SLOW_LOAD_MS);
  // `dom-ready`, not `did-finish-load`: the latter is the load event, which waits for
  // every font, tile and analytics beacon the page pulls in. Measured on a page with no
  // subresources at all, the load event still trailed the response by three seconds — on
  // the real site it is far behind the point where the app is there and usable, and the
  // splash sitting through all of it is what made it feel long. Finish stays as a backstop.
  wc.once('dom-ready', reveal);
  wc.once('did-finish-load', reveal);
  // A failed load (offline / DNS / prod outage) puts the local screen up rather than
  // stranding a blank window; it owns the retry from there and comes back to the URL that
  // failed, not home. Ignore -3 (ABORTED), which fires on normal in-page navigations.
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    lastTarget = url || lastTarget;
    blocked?.show(net.isOnline() ? 'unreachable' : 'offline');
    reveal(); // the stand-in screen is what needs to be on screen now, not the splash
  });
  win.on('focus', () => {
    if (blocked?.isUp()) blocked.focus();
    else wc.focus();
  });

  void wc.loadURL(APP_URL);
}

/** Wires the IPC between the title bar, the site view, and the native chrome. */
function registerIpc(): void {
  // Theme reported by the site preload -> tint the strip + native chrome.
  ipcMain.on(
    'ss:theme',
    (
      _event,
      payload: { themeSource?: string; color?: string; mode?: string },
    ) => {
      // Behind the stand-in screen the site view may be holding an error page rather than
      // the app. What that corrupts is the reported COLOUR — no theme-color meta and no
      // dark class, so the preload reads white, and taking it would repaint the window and
      // the chrome in light theme for a dark-theme user. The mode is read from
      // same-origin storage and survives such a page intact, so it is still honoured:
      // dropping it wholesale meant a theme change made on a live page behind a
      // mid-session block was silently lost.
      const blindToColour = blocked?.isUp() === true;
      const themeSource = payload?.themeSource;
      if (
        themeSource === 'light' ||
        themeSource === 'dark' ||
        themeSource === 'system'
      ) {
        nativeTheme.themeSource = themeSource; // traffic-light + text contrast
      }
      const mode = parseThemeMode(payload?.mode);
      if (mode) {
        lastMode = mode;
        saveThemeMode(mode); // so the next launch's splash opens on the same ground
      }
      const color = payload?.color;
      if (
        !blindToColour &&
        typeof color === 'string' &&
        /^#[0-9a-fA-F]{6}$/.test(color)
      ) {
        lastDark = isDarkColor(color);
        mainWindow?.setBackgroundColor(color);
        siteView?.setBackgroundColor(color); // load placeholder; the title bar stays transparent
      }
      // Always push: the mode can change without the colour changing (e.g. dark -> auto).
      broadcastTheme();
    },
  );

  // Title-bar utility buttons -> the web app's existing handlers (via its preload).
  ipcMain.on('titlebar:command', (_event, cmd: string) => sendCommand(cmd));
  // The web app reports its cursor on/off so the title-bar icon can mirror it.
  ipcMain.on('ss:cursor', (_event, on: boolean) => {
    lastCursorOn = Boolean(on);
    titleBarView?.webContents.send('titlebar:cursor', lastCursorOn);
  });
  // The web app reports its active filter count so the title-bar icon can badge it.
  ipcMain.on('ss:filters', (_event, count: number) => {
    lastFilterCount = Math.max(0, Math.trunc(Number(count) || 0));
    titleBarView?.webContents.send('titlebar:filters', lastFilterCount);
  });
  // The web app reports its screensaver taking over the window (and handing it back). It
  // may not take it while the stand-in screen is up: the covered page keeps its own idle
  // timer running and sees none of the input landing on that screen, so it would eventually
  // fade the title bar and hide the window buttons over a screensaver nobody can see.
  ipcMain.on('ss:screensaver', (_event, on: boolean) => {
    if (on && blocked?.isUp()) return;
    setScreenSaver(Boolean(on));
  });
  // Share = copy the canonical URL via the main-process clipboard (no user gesture needed).
  ipcMain.on('ss:clipboard', (_event, text: string) => {
    if (typeof text === 'string' && text) {
      clipboard.writeText(text);
      titleBarView?.webContents.send('titlebar:copied');
    }
  });

  // Back/forward from the title-bar arrows -> drive the site view's history.
  ipcMain.on('titlebar:nav', (_event, dir: 'back' | 'forward') =>
    navigate(dir),
  );

  // Button hover from the bar -> position + show the keycap tooltip view (fade + hide on leave).
  ipcMain.on(
    'titlebar:tooltip',
    (_event, payload: { kind: string; x: number } | null) => {
      const tip = tooltipView;
      if (!tip) return;
      // The tooltip is its own view and never gets the screensaver fade, so a hover on
      // invisible chrome would pop an opaque keycap on top of the screensaver.
      if (screenSaverOn) {
        tip.setVisible(false);
        return;
      }
      if (payload) {
        const caretX = positionTooltip(
          tip,
          TITLEBAR_HEIGHT,
          mainWindow?.getContentBounds().width ?? 0,
          payload.x,
        );
        tip.webContents.send('tooltip:show', { kind: payload.kind, caretX });
      } else {
        // Hide the view immediately: a lingering overlay over page content captures clicks.
        tip.setVisible(false);
        tip.webContents.send('tooltip:show', null);
      }
    },
  );

  // The site's update toast -> restart into the downloaded version.
  ipcMain.on('ss:install-update', () => installPendingUpdate());
  // The toast subscribed (post-hydration, any document) -> offer a pending update.
  // Pushing on load events instead would race hydration and lose the message.
  ipcMain.on('ss:update-subscribe', (event) => {
    const update = getPendingUpdate();
    if (update) event.sender.send('ss:update-ready', update);
  });

  // Custom window buttons (Windows/Linux) -> drive the native window.
  ipcMain.on('titlebar:window-control', (_event, action: string) => {
    const win = mainWindow;
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
  });

  // The stand-in screen's "Try now" -> check straight away instead of waiting out the timer.
  ipcMain.on('blocked:retry', () => blocked?.retry());
  // The stand-in screen reporting a frame on the glass — what the launch splash waits for.
  ipcMain.on('blocked:painted', (event) => blocked?.markPainted(event.sender));

  // A local view (bar, tooltip or stand-in screen) loaded -> send it the theme; the bar
  // also gets its full state, and the stand-in screen why it is up.
  ipcMain.on('titlebar:ready', (event) => {
    event.sender.send('titlebar:theme', { dark: lastDark, mode: lastMode });
    blocked?.sendStateTo(event.sender);
    // The rest is bar-only state; skip it when another view is the one reporting ready.
    if (event.sender !== titleBarView?.webContents) return;
    titleBarView?.webContents.send('titlebar:cursor', lastCursorOn);
    titleBarView?.webContents.send('titlebar:filters', lastFilterCount);
    // A bar that reloads mid-screensaver comes back opaque without this.
    titleBarView?.webContents.send('titlebar:screensaver', screenSaverOn);
    titleBarView?.webContents.send(
      'titlebar:maximized',
      mainWindow?.isMaximized() ?? false,
    );
    // Not the page's title while the stand-in screen is up: a bar that loads or reloads
    // then would otherwise replace what the screen is saying with a stale page title.
    pushTitle(currentTitle());
    pushNavState();
  });
}

void app.whenReady().then(() => {
  // The recovery check goes through net.fetch, which the certificate-error hook above does
  // not cover — without this it could never succeed against the dev origin's own cert.
  if (isDev) {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      callback(request.hostname === new URL(APP_URL).hostname ? 0 : -3);
    });
  }
  setupMenu(APP_URL);
  registerIpc();
  createWindow();
  initAutoUpdates(APP_URL, (update) => {
    siteView?.webContents.send('ss:update-ready', update);
  });

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
