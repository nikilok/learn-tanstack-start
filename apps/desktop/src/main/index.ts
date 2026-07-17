import { join } from 'node:path';

import {
  app,
  BaseWindow,
  clipboard,
  ipcMain,
  nativeTheme,
  shell,
  WebContentsView,
} from 'electron';

import { registerKeyboardShortcuts } from './keyboard-shortcuts';
import { setupMenu } from './menu';
import { createTooltipView, positionTooltip } from './tooltip-overlay';
import {
  getPendingUpdateVersion,
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
const INITIAL_BG = '#120817'; // PWA splash navy, until the page reports its theme colour

let mainWindow: BaseWindow | null = null;
let titleBarView: WebContentsView | null = null;
let siteView: WebContentsView | null = null;
let tooltipView: WebContentsView | null = null;
let lastDark = true;
let lastCursorOn = true; // custom-cursor on/off, mirrored to the title bar
let lastMode = 'auto'; // theme mode (light/dark/auto), for the title bar icon

/** True when a #rrggbb colour is dark enough to want light foreground text. */
function isDarkColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** Chrome-like UA with the "Electron" token stripped (so the WAF sees a normal browser) plus a desktop marker. */
function desktopUserAgent(defaultUA: string): string {
  const chromeUA = defaultUA
    .replace(/ Electron\/[\d.]+/, '')
    .replace(new RegExp(` ${app.getName()}\\/[\\d.]+`), '');
  return `${chromeUA} SponsorSearchDesktop/${app.getVersion()}`;
}

/** Sends any off-origin http(s) link to the user's default browser. */
function openExternal(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

/** Pushes the site's back/forward availability to the title bar buttons. */
function pushNavState(): void {
  const h = siteView?.webContents.navigationHistory;
  titleBarView?.webContents.send('titlebar:navstate', {
    canGoBack: h?.canGoBack() ?? false,
    canGoForward: h?.canGoForward() ?? false,
  });
}

/** Drives the site view's history back/forward, then hands keyboard focus back to the page. */
function navigate(dir: 'back' | 'forward'): void {
  const h = siteView?.webContents.navigationHistory;
  if (!h) return;
  if (dir === 'back' && h.canGoBack()) h.goBack();
  else if (dir === 'forward' && h.canGoForward()) h.goForward();
  siteView?.webContents.focus();
}

/** Forwards a title-bar command to the web app (its DesktopBridge handles share / cursor / theme / home). */
function sendCommand(cmd: string): void {
  siteView?.webContents.send('ss:command', cmd);
  if (cmd === 'home') siteView?.webContents.focus(); // type-to-search wants the page focused
}

/** Strips the SEO site-name suffix so the pill shows just the meaningful title. */
function cleanTitle(title: string): string {
  return title
    .replace(/\s*[|—–-]\s*SponsorSearch(\.co\.uk)?\s*$/i, '')
    .replace(/\s*-\s*UK Visa Sponsor\s*$/i, '')
    .trim();
}

/** Sends the current page title (cleaned) to the title bar pill. */
function pushTitle(title: string): void {
  titleBarView?.webContents.send('titlebar:title', cleanTitle(title));
}

/** Pushes the current theme to both title-bar views — the bar and the tooltip overlay. */
function broadcastTheme(): void {
  const payload = { dark: lastDark, mode: lastMode };
  titleBarView?.webContents.send('titlebar:theme', payload);
  tooltipView?.webContents.send('titlebar:theme', payload);
}

/** Creates the window: a custom title-bar view above a WebContentsView of the hosted site. */
function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const win = new BaseWindow({
    width: 1280,
    height: 860,
    // Floor for the flat title bar: keeps a usable gap between the logo/nav and utility clusters for the centered title.
    minWidth: 800,
    minHeight: 480,
    show: false,
    backgroundColor: INITIAL_BG,
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
  view.setBackgroundColor(INITIAL_BG);
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

  win.contentView.addChildView(view); // site fills the window, behind…
  win.contentView.addChildView(bar); // …the transparent title bar on top

  // A tiny, initially-hidden overlay above everything, positioned per-hover to show the
  // nav keycap tooltip below the arrows (the 46px bar would otherwise clip it).
  const tip = createTooltipView();
  win.contentView.addChildView(tip);
  tooltipView = tip;

  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
    bar.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
    tip.setVisible(false); // stale on resize; the next hover re-positions + shows it
  };
  layout();
  win.on('resize', layout);

  const wc = view.webContents;
  wc.setUserAgent(desktopUserAgent(wc.getUserAgent()));

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
  wc.on('did-navigate', pushNavState);
  wc.on('did-navigate-in-page', pushNavState);
  wc.on('page-title-updated', (_e, title) => pushTitle(title));

  // Cmd/Ctrl + [ / ] back / forward, whichever view holds focus (see keyboard-shortcuts.ts).
  registerKeyboardShortcuts([wc, bar.webContents], {
    navigate,
    command: sendCommand,
  });

  // Hand keyboard focus to the site view (not the title bar) so typing reaches the
  // page right away — the web app's type-to-search needs the document focused.
  const show = (): void => {
    if (win.isDestroyed()) return; // timer/load may fire after a fast window close
    win.show();
    wc.focus();
  };
  // Fallback if the initial load stalls; cleared once the load finishes so it
  // can't fire show() against a destroyed window.
  const showTimer = setTimeout(show, 4000);
  wc.once('did-finish-load', () => {
    clearTimeout(showTimer);
    show();
  });
  // Retry a failed load (offline / DNS / prod outage) rather than stranding a blank
  // window — retry the URL that failed, not home, so the user's page survives the
  // hiccup; ignore -3 (ABORTED), which fires on normal in-page navigations.
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      const target = url || APP_URL;
      setTimeout(() => {
        if (!wc.isDestroyed()) void wc.loadURL(target);
      }, 2000);
    }
  });
  win.on('focus', () => wc.focus());

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
      const themeSource = payload?.themeSource;
      if (
        themeSource === 'light' ||
        themeSource === 'dark' ||
        themeSource === 'system'
      ) {
        nativeTheme.themeSource = themeSource; // traffic-light + text contrast
      }
      if (payload?.mode) lastMode = payload.mode;
      const color = payload?.color;
      if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
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
    const version = getPendingUpdateVersion();
    if (version) event.sender.send('ss:update-ready', version);
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

  // A title-bar view (bar or tooltip) loaded -> send it the theme; the bar also gets its full state.
  ipcMain.on('titlebar:ready', (event) => {
    event.sender.send('titlebar:theme', { dark: lastDark, mode: lastMode });
    // The rest is bar-only state; skip it when the tooltip view is the one reporting ready.
    if (event.sender !== titleBarView?.webContents) return;
    titleBarView?.webContents.send('titlebar:cursor', lastCursorOn);
    titleBarView?.webContents.send(
      'titlebar:maximized',
      mainWindow?.isMaximized() ?? false,
    );
    pushTitle(siteView?.webContents.getTitle() ?? '');
    pushNavState();
  });
}

void app.whenReady().then(() => {
  setupMenu(APP_URL);
  registerIpc();
  createWindow();
  initAutoUpdates((version) => {
    siteView?.webContents.send('ss:update-ready', version);
  });

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
