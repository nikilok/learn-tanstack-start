import { useEffect, useState } from 'react';

/**
 * A Chromium-family browser we ship a dedicated logo for; `chromium` is the
 * generic fallback for unrecognised forks (Arc, etc.).
 */
export type BrowserKey =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'opera'
  | 'vivaldi'
  | 'chromium';

/** UA sniff for the Chromium fork — forks are checked before generic Chrome because they all carry the `Chrome/` token. Brave clones Chrome's UA exactly, so it is resolved separately (async) in useBrowser. */
function detectFromUA(ua: string): BrowserKey {
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'chromium';
}

/**
 * The visitor's Chromium-family browser, for picking its logo. Only meaningful
 * on the client (the PWA-install surfaces that consume it are client-only), so
 * it reads `navigator` directly. Brave hides behind Chrome's UA, so it's
 * detected via the `navigator.brave` API, which resolves after first paint.
 */
export function useBrowser(): BrowserKey {
  const [browser, setBrowser] = useState<BrowserKey>(() =>
    typeof navigator === 'undefined'
      ? 'chromium'
      : detectFromUA(navigator.userAgent),
  );

  useEffect(() => {
    const nav = navigator as Navigator & {
      brave?: { isBrave?: () => Promise<boolean> };
    };
    if (!nav.brave?.isBrave) return;
    let cancelled = false;
    nav.brave
      .isBrave()
      .then((isBrave) => {
        if (isBrave && !cancelled) setBrowser('brave');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return browser;
}
