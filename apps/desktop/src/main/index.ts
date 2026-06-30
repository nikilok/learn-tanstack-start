import { join } from 'node:path';

import {
  app,
  BaseWindow,
  ipcMain,
  nativeTheme,
  shell,
  WebContentsView,
} from 'electron';

import { setupMenu } from './menu';
import { initAutoUpdates } from './updater';

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
// The custom title bar lives in its own view above the site; the site renders in a
// view BELOW it, so its viewport simply starts here — the hosted page is untouched.
const TITLEBAR_HEIGHT = 46;
const INITIAL_BG = '#120817'; // PWA splash navy, until the page reports its theme colour

let mainWindow: BaseWindow | null = null;
let titleBarView: WebContentsView | null = null;
let siteView: WebContentsView | null = null;
let lastDark = true;
let lastCursorOn = true; // custom-cursor on/off, mirrored to the title bar

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

/** Creates the window: a custom title-bar view above a WebContentsView of the hosted site. */
function createWindow(): void {
  const win = new BaseWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 480,
    show: false,
    backgroundColor: INITIAL_BG,
    titleBarStyle: 'hiddenInset', // keep the traffic lights, drop the native bar
    trafficLightPosition: { x: 20, y: 16 },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      titleBarView = null;
      siteView = null;
    }
  });

  // Title bar (custom chrome). Its colour is the view background (set on theme);
  // the page body is transparent and just hosts the buttons + centered title.
  const bar = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/titlebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  bar.setBackgroundColor(INITIAL_BG);
  if (process.env['ELECTRON_RENDERER_URL']) {
    void bar.webContents.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void bar.webContents.loadFile(join(__dirname, '../renderer/index.html'));
  }
  titleBarView = bar;
  win.contentView.addChildView(bar);

  // The hosted site, rendered below the title bar.
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
  win.contentView.addChildView(view);

  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    bar.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
    view.setBounds({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    });
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

  // Hand keyboard focus to the site view (not the title bar) so typing reaches the
  // page right away — the web app's type-to-search needs the document focused.
  const show = (): void => {
    win.show();
    wc.focus();
  };
  wc.once('did-finish-load', show);
  setTimeout(show, 4000); // fallback if the initial load stalls
  win.on('focus', () => wc.focus());

  void wc.loadURL(APP_URL);
}

/** Wires the IPC between the title bar, the site view, and the native chrome. */
function registerIpc(): void {
  // Theme reported by the site preload -> tint the strip + native chrome.
  ipcMain.on(
    'ss:theme',
    (_event, payload: { themeSource?: string; color?: string }) => {
      const themeSource = payload?.themeSource;
      if (
        themeSource === 'light' ||
        themeSource === 'dark' ||
        themeSource === 'system'
      ) {
        nativeTheme.themeSource = themeSource; // traffic-light + text contrast
      }
      const color = payload?.color;
      if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
        lastDark = isDarkColor(color);
        mainWindow?.setBackgroundColor(color);
        titleBarView?.setBackgroundColor(color);
        titleBarView?.webContents.send('titlebar:theme', { dark: lastDark });
      }
    },
  );

  // Title-bar utility buttons -> the web app's existing handlers (via its preload).
  ipcMain.on('titlebar:command', (_event, cmd: string) =>
    siteView?.webContents.send('ss:command', cmd),
  );
  // The web app reports its cursor on/off so the title-bar icon can mirror it.
  ipcMain.on('ss:cursor', (_event, on: boolean) => {
    lastCursorOn = Boolean(on);
    titleBarView?.webContents.send('titlebar:cursor', lastCursorOn);
  });

  // Back/forward from the title bar -> drive the site view's history.
  ipcMain.on('titlebar:nav', (_event, dir: 'back' | 'forward') => {
    const h = siteView?.webContents.navigationHistory;
    if (!h) return;
    if (dir === 'back' && h.canGoBack()) h.goBack();
    if (dir === 'forward' && h.canGoForward()) h.goForward();
    siteView?.webContents.focus(); // return keyboard focus to the page after navigating
  });

  // Title bar finished loading -> hand it the current state.
  ipcMain.on('titlebar:ready', () => {
    titleBarView?.webContents.send('titlebar:theme', { dark: lastDark });
    titleBarView?.webContents.send('titlebar:cursor', lastCursorOn);
    pushTitle(siteView?.webContents.getTitle() ?? '');
    pushNavState();
  });
}

void app.whenReady().then(() => {
  setupMenu(APP_URL);
  registerIpc();
  createWindow();
  initAutoUpdates();

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
