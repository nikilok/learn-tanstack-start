/**
 * Rendering a page in headless Chromium, for a candidate whose raw HTML shows
 * the walk nothing. The fetcher's guards hold for every page asked for and
 * every page landed on (robots.txt, public addresses only, our user agent);
 * every connection the browser makes goes through the guard proxy; images,
 * media, fonts and stylesheets are never loaded; a render has a hard time
 * limit; and the browser runs without the job's secrets in its environment.
 */

import type { Browser, BrowserContext, Page, Route } from 'playwright';

import { startGuardProxy } from './guard-proxy.ts';
import {
  checkFetchable,
  type FetchFailure,
  type SiteFetch,
  USER_AGENT,
} from './web-fetch.ts';

/** Resource types a render never loads: what a page says is in its HTML and scripts. */
const SKIPPED = new Set(['image', 'media', 'font', 'stylesheet']);

/** Longest a page may take to load, to settle after loading, and in all. */
const LOAD_MS = 20_000;
const SETTLE_MS = 6_000;
const RENDER_MS = 45_000;

/** Longest a page or a browser context may take to close. */
const CLOSE_MS = 10_000;

/** As much of a rendered page as the fetcher reads of a plain one. */
const MAX_HTML_CHARS = 2_000_000;

/** What a render does with one request the page makes. */
export function requestVerdict(
  url: string,
  resourceType: string,
): 'continue' | 'abort' {
  // In-page data never leaves the browser.
  if (/^(data|blob):/i.test(url)) return 'continue';
  if (!/^https?:/i.test(url)) return 'abort';
  return SKIPPED.has(resourceType) ? 'abort' : 'continue';
}

/** A promise that settles within ms, else rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('render time limit')), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** The browser's environment: enough to run, none of the job's secrets. */
function browserEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/** A render that came to nothing, for the fetcher's reason. */
function failed(url: string, reason: FetchFailure, status?: number): SiteFetch {
  return { ok: false, reason, status, attempts: 1, attemptedUrl: url };
}

/** Load or refuse one request a page makes; a page that closed mid-request has nothing left to answer. */
async function answer(route: Route): Promise<void> {
  const request = route.request();
  const verdict = requestVerdict(request.url(), request.resourceType());
  await (verdict === 'continue' ? route.continue() : route.abort()).catch(
    () => {},
  );
}

/** Load one page and read it once its scripts settle, keeping the page so the caller can close it. */
async function load(
  context: BrowserContext,
  url: string,
  opened: { page?: Page },
): Promise<SiteFetch> {
  const page = await context.newPage();
  opened.page = page;
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: LOAD_MS,
  });
  if (!response) return failed(url, 'http_error');
  if (response.status() >= 400) {
    return failed(url, 'http_error', response.status());
  }
  await page
    .waitForLoadState('networkidle', { timeout: SETTLE_MS })
    .catch(() => {});
  // The page it landed on passes the same guards as the one it asked for.
  const landed = page.url();
  const blocked = await checkFetchable(landed);
  if (blocked) return failed(url, blocked);
  return {
    ok: true,
    url: landed,
    status: response.status(),
    html: (await page.content()).slice(0, MAX_HTML_CHARS),
    attempts: 1,
    attemptedUrl: url,
  };
}

/** One page rendered under the time limit, the page closed whatever happens. */
async function renderIn(
  context: BrowserContext,
  url: string,
): Promise<SiteFetch> {
  const opened: { page?: Page } = {};
  try {
    return await within(load(context, url, opened), RENDER_MS);
  } catch (error) {
    const timedOut = /time|limit/i.test(
      error instanceof Error ? error.message : '',
    );
    return failed(url, timedOut ? 'timeout' : 'dns_or_refused');
  } finally {
    if (opened.page)
      await within(opened.page.close(), CLOSE_MS).catch(() => {});
  }
}

/** Pages rendered one after another in one browser context, as one visit to one site. */
export type RenderVisit = {
  /** Render one page; a failure carries the fetcher's reasons. */
  render(url: string): Promise<SiteFetch>;
  close(): Promise<void>;
};

export type Renderer = {
  /** A visit in a context of its own: nothing one site leaves in the browser reaches another. */
  visit(): RenderVisit;
  close(): Promise<void>;
};

/** Chromium behind the guard proxy, launched for renders until closed. */
export async function launchRenderer(): Promise<Renderer> {
  const proxy = await startGuardProxy();
  const open = async () => {
    const { chromium } = await import('playwright');
    return chromium.launch({
      headless: true,
      env: browserEnv(),
      // Loopback included: nothing the browser opens skips the proxy.
      proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      // A signal ends the run as it would without a browser, and the browser with it.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  };
  let browser: Browser;
  try {
    browser = await open();
  } catch (error) {
    await proxy.close();
    throw error;
  }
  let reopening: Promise<Browser> | null = null;
  /** The browser, started again once if it crashed, however many renders ask at once. */
  const running = async () => {
    if (browser.isConnected()) return browser;
    reopening ??= open()
      .then((next) => (browser = next))
      .finally(() => {
        reopening = null;
      });
    return reopening;
  };
  return {
    visit() {
      let context: Promise<BrowserContext> | null = null;
      /** The visit's context, made on its first page. */
      const opened = () => {
        context ??= (async () => {
          const made = await (
            await running()
          ).newContext({
            userAgent: USER_AGENT,
            serviceWorkers: 'block',
            acceptDownloads: false,
          });
          // On the context, so a popup a page opens is held to the same rule.
          await made.route('**/*', answer);
          return made;
        })();
        return context;
      };
      return {
        async render(url) {
          const blocked = await checkFetchable(url);
          if (blocked) return failed(url, blocked);
          return renderIn(await opened(), url);
        },
        async close() {
          if (!context) return;
          await within(
            context.then((made) => made.close()),
            CLOSE_MS,
          ).catch(() => {});
        },
      };
    },
    async close() {
      await browser.close().catch(() => {});
      await proxy.close();
    },
  };
}
