/**
 * Regenerates the theme-transition colour matrices from live page screenshots.
 *
 * Captures each sampled page (home, details, search results, mobile home) in
 * light and dark via headless Chrome, downsamples to MAP_COLS×MAP_ROWS with
 * sips (macOS), and rewrites the packed hex constants in theme-transition.ts.
 *
 * Run whenever the visual design changes:
 *   bun apps/web/scripts/sample-theme-matrices.ts
 * Env: BASE_URL to sample somewhere other than production (e.g. the dev
 * server — dev-only chrome like the devtools badge is hidden best-effort).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'https://sponsorsearch.co.uk';
const TARGET = new URL('../src/theme-transition.ts', new URL(import.meta.url))
  .pathname;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9345;
const COLS = 24;
const ROWS = 16;
// Post-navigation settle: hydration, entrance fills and the footer smoke burst.
const SETTLE_MS = 7000;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Waits for the DevTools endpoint and returns the page target's socket URL. */
async function getWsUrl(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = (await (
        await fetch(`http://127.0.0.1:${PORT}/json`)
      ).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('headless chrome never came up');
}

/** Parses a 24-bit BMP into row-major top→bottom [r, g, b] pixels. */
function parseBmp(buf: Uint8Array): number[][] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dataOffset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  if (bpp !== 24) throw new Error(`expected 24bpp BMP, got ${bpp}`);
  const rows = Math.abs(height);
  const stride = Math.ceil((width * 3) / 4) * 4;
  const px: number[][] = [];
  for (let y = 0; y < rows; y++) {
    // positive height = bottom-up row order
    const srcY = height > 0 ? rows - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const o = dataOffset + srcY * stride + x * 3;
      px.push([buf[o + 2], buf[o + 1], buf[o]]);
    }
  }
  return px;
}

/** Packs [r, g, b] pixels as the transition's `rrggbb…` hex string. */
function packHex(px: number[][]): string {
  return px
    .map((p) => p.map((c) => c.toString(16).padStart(2, '0')).join(''))
    .join('');
}

const work = mkdtempSync(join(tmpdir(), 'theme-matrices-'));
const chrome = Bun.spawn(
  [
    CHROME,
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--ignore-certificate-errors',
    `--user-data-dir=${join(work, 'profile')}`,
    '--window-size=1280,860',
    '--no-first-run',
    'about:blank',
  ],
  { stdout: 'ignore', stderr: 'ignore' },
);

try {
  const ws = new WebSocket(await getWsUrl());
  let msgId = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg.result ?? msg.error);
      pending.delete(msg.id);
    }
  };
  await new Promise((res) => {
    ws.onopen = res;
  });
  const send = (method: string, params: object = {}) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise<any>((res) => pending.set(id, res));
  };

  await send('Page.enable');
  // A regular UA so production bot protection doesn't challenge the captures.
  await send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  });

  /** Captures the current viewport, downsampled to a packed hex matrix. */
  const sample = async (name: string): Promise<string> => {
    const png = join(work, `${name}.png`);
    const bmp = join(work, `${name}.bmp`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await Bun.write(png, Buffer.from(shot.data, 'base64'));
    const sips = Bun.spawnSync([
      'sips',
      '-z',
      String(ROWS),
      String(COLS),
      '-s',
      'format',
      'bmp',
      png,
      '--out',
      bmp,
    ]);
    if (sips.exitCode !== 0) throw new Error(`sips failed for ${name}`);
    const hex = packHex(parseBmp(new Uint8Array(await Bun.file(bmp).bytes())));
    if (hex.length !== COLS * ROWS * 6) throw new Error(`bad matrix ${name}`);
    return hex;
  };

  /** Loads a page in the given theme/viewport and waits for it to settle.
   * `reduced` freezes animated pages (e.g. /download's preview tour). */
  const load = async (
    url: string,
    dark: boolean,
    mobile: boolean,
    reduced = false,
  ) => {
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
        {
          name: 'prefers-reduced-motion',
          value: reduced ? 'reduce' : 'no-preference',
        },
      ],
    });
    if (mobile) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
    } else {
      await send('Emulation.clearDeviceMetricsOverride');
    }
    await send('Page.navigate', { url });
    await sleep(SETTLE_MS);
    // dev-only chrome (devtools badge) would leak into the matrix — hide it
    await send('Runtime.evaluate', {
      expression: `for (const el of document.querySelectorAll('img,button,div')) {
        if (/tanstack/i.test(el.className + (el.getAttribute?.('src') ?? '') + (el.getAttribute?.('alt') ?? ''))) el.style.display = 'none';
      }`,
    });
    await sleep(200);
  };

  // details page: first company link off the search results, read via the
  // browser session (a bare fetch can be challenged by bot protection)
  await load(`${BASE_URL}/?search=bbc`, false, false);
  const detailsPath = (
    await send('Runtime.evaluate', {
      expression: `document.querySelector('a[href^="/company/"]')?.getAttribute('href')`,
      returnByValue: true,
    })
  ).result?.value as string | undefined;
  if (!detailsPath) throw new Error('no company link found on search page');
  console.log('details page:', detailsPath);

  // Force the PWA install-card state via the app's own event chain (see
  // install-prompt-init.ts / useInstallPrompt), so the two /download variants
  // sample deterministically regardless of whether headless Chrome's service
  // worker actually fired beforeinstallprompt.
  const FORCE_NO_INSTALL = `window.__ssInstallPrompt = null; window.dispatchEvent(new Event('ss:installed'));`;
  const FORCE_INSTALL = `window.__ssInstallPrompt = new Event('beforeinstallprompt'); window.dispatchEvent(new Event('ss:installable'));`;

  const pages: Array<{
    key: string;
    url: string;
    mobile: boolean;
    reduced?: boolean;
    setup?: string;
  }> = [
    { key: 'HOME', url: `${BASE_URL}/`, mobile: false },
    { key: 'DETAILS', url: `${BASE_URL}${detailsPath}`, mobile: false },
    { key: 'SEARCH', url: `${BASE_URL}/?search=bbc`, mobile: false },
    { key: 'MOBILE', url: `${BASE_URL}/`, mobile: true },
    {
      key: 'DOWNLOAD',
      url: `${BASE_URL}/download`,
      mobile: false,
      reduced: true,
      setup: FORCE_NO_INSTALL,
    },
    {
      key: 'DOWNLOAD_INSTALL',
      url: `${BASE_URL}/download`,
      mobile: false,
      reduced: true,
      setup: FORCE_INSTALL,
    },
  ];

  // Layout anchors (viewport fractions) so the runtime can warp the matrices
  // onto the live layout — mirror measureAnchors() in theme-transition.ts.
  const ANCHOR_EXPR = `(() => {
    const f = (n) => Math.round(n * 1000) / 1000;
    const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const wrap = rect('.page-wrap');
    const head = rect('header');
    const hero = rect('[data-hero-stat]');
    const sky = rect('[data-london-skyline]');
    return {
      colL: wrap ? f(wrap.left / innerWidth) : -1,
      colR: wrap ? f(wrap.right / innerWidth) : -1,
      header: head ? f(head.bottom / innerHeight) : -1,
      hero: hero ? f((hero.top + hero.bottom) / 2 / innerHeight) : -1,
      skyT: sky ? f(sky.top / innerHeight) : -1,
      skyB: sky ? f(sky.bottom / innerHeight) : -1,
    };
  })()`;

  let source = await Bun.file(TARGET).text();
  for (const page of pages) {
    for (const dark of [false, true]) {
      const constName = `${page.key}_${dark ? 'DARK' : 'LIGHT'}_HEX`;
      await load(page.url, dark, page.mobile, page.reduced);
      if (page.setup) {
        await send('Runtime.evaluate', { expression: page.setup });
        await sleep(700);
      }
      const hex = await sample(constName);
      // also matches the '…'.repeat(MAP_N) placeholder form of a new set
      const re = new RegExp(
        `(const ${constName} =\\s*)'[0-9a-f]+'(\\.repeat\\(MAP_N\\))?`,
      );
      if (!re.test(source)) throw new Error(`constant ${constName} not found`);
      source = source.replace(re, `$1'${hex}'`);
      console.log(`sampled ${constName}`);
      if (!dark) {
        const a = (
          await send('Runtime.evaluate', {
            expression: ANCHOR_EXPR,
            returnByValue: true,
          })
        ).result?.value as Record<string, number>;
        const lit = `{ colL: ${a.colL}, colR: ${a.colR}, header: ${a.header}, hero: ${a.hero}, skyT: ${a.skyT}, skyB: ${a.skyB} }`;
        const are = new RegExp(
          `(const ${page.key}_ANCHORS: PageAnchors = )\\{[^}]*\\}`,
        );
        if (!are.test(source)) throw new Error(`anchors ${page.key} not found`);
        source = source.replace(are, `$1${lit}`);
        console.log(`anchors ${page.key}:`, lit);
      }
    }
  }
  await Bun.write(TARGET, source);
  console.log('theme-transition.ts matrices updated');
  ws.close();
} finally {
  chrome.kill();
  rmSync(work, { recursive: true, force: true });
}
