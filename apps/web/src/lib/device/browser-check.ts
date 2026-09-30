import { initBotId } from 'botid/client/core';

import { isDesktopPreview } from '../../utils/desktop-preview';
import { BROWSER_CHECK_LEVEL } from './browser-check-config';

/**
 * The calls the browser check stands in front of: the app's POST server functions, whose paths
 * change with every build. The check's challenge rides each of them, at the level the server
 * asks for (`BROWSER_CHECK_LEVEL`); only the handlers that ask Vercel for a verdict
 * (`browser-check.server.ts`) are charged for one.
 */
export const CHECKED_CALLS = [
  {
    path: '/_serverFn/*',
    method: 'POST',
    advancedOptions: { checkLevel: BROWSER_CHECK_LEVEL },
  },
];

let started = false;

/**
 * Starts the browser check once per document, from a root effect, ahead of the page's first
 * checked call — the company extras wait on the device key, which waits for idle time. The
 * /download preview iframes stay out, as with the device pings: they never load the extras.
 */
export function initBrowserCheck(): void {
  if (started) return;
  started = true;
  if (typeof window === 'undefined' || isDesktopPreview()) return;
  initBotId({ protect: CHECKED_CALLS });
}
