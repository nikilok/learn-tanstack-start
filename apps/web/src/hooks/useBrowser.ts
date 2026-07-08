import { useState } from 'react';

/**
 * A browser we ship a dedicated logo for on the PWA-install surfaces. `chromium`
 * is a neutral fallback for UAs carrying no recognisable token; Chrome-engine
 * forks that keep the `Chrome/` token (Arc, plain Chromium) can't be told apart
 * from Chrome via the UA, so they report as `chrome`.
 */
export type BrowserKey =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'opera'
  | 'vivaldi'
  | 'chromium';

/** UA sniff — the forks are checked before generic Chrome because they all carry the `Chrome/` token too. Brave is handled separately (it clones Chrome's UA with no token) in detectBrowser. */
function detectFromUA(ua: string): BrowserKey {
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'chromium';
}

/** Resolve the browser synchronously. Brave is detected via the `navigator.brave` object it injects (its UA is indistinguishable from Chrome's), checked before the UA sniff so the correct logo paints on the first frame — no post-paint swap. */
function detectBrowser(): BrowserKey {
  if (typeof navigator === 'undefined') return 'chromium';
  if ('brave' in navigator) return 'brave';
  return detectFromUA(navigator.userAgent);
}

/**
 * The visitor's browser, for picking its logo. Only meaningful on the client
 * (the PWA-install surfaces that consume it are client-only), so it reads
 * `navigator` directly and resolves synchronously.
 */
export function useBrowser(): BrowserKey {
  const [browser] = useState<BrowserKey>(detectBrowser);
  return browser;
}
