import { initBotId } from 'botid/client/core';

import { SESSION_PATH } from '../session/calls';
import { BROWSER_CHECK_LEVEL } from './browser-check-config';

/**
 * The calls the browser check stands in front of: the app's POST server functions, whose paths
 * change with every build, and the session endpoint. The check's challenge rides each of them, at
 * the level the server asks for (`BROWSER_CHECK_LEVEL`); only the handlers that ask Vercel for a
 * verdict (`browser-check.server.ts`) are charged for one.
 */
export const CHECKED_CALLS = [
  {
    path: '/_serverFn/*',
    method: 'POST',
    advancedOptions: { checkLevel: BROWSER_CHECK_LEVEL },
  },
  {
    path: SESSION_PATH,
    method: 'POST',
    advancedOptions: { checkLevel: BROWSER_CHECK_LEVEL },
  },
];

let started = false;

/** Session asks waiting for the check to let them go, oldest first. */
let awaitingRelease: Array<() => void> = [];

/**
 * Resolves when the browser check lets the next session ask go to the server. The check holds an
 * ask until its challenge has run, which can take a long while on a slow device, so the session
 * times the server's answer from here rather than from the ask. Each new ask replaces any earlier
 * one still waiting: those have been given up on. Never resolves where the check does not run.
 */
export function sessionAskReleased(): Promise<void> {
  return new Promise((resolve) => {
    awaitingRelease = [resolve];
  });
}

/** Whether a fetch is the session ask. */
function isSessionAsk(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): boolean {
  const request = input instanceof Request ? input : null;
  const url = request ? request.url : String(input);
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  return (
    method === 'POST' &&
    new URL(url, 'http://localhost').pathname === SESSION_PATH
  );
}

/**
 * Starts the browser check once per document, ahead of the page's first checked call: from a root
 * effect, and from the session's fetch before a company data call, which a page can make before
 * its effects run. /download preview iframes run it too: their company pages load their data
 * through the same checked call.
 *
 * The check keeps the fetch it finds when it starts and sends each call it held through it, so a
 * wrapper put in first sees a session ask the moment it leaves (`sessionAskReleased`).
 */
export function initBrowserCheck(): void {
  if (started) return;
  started = true;
  if (typeof window === 'undefined') return;
  const send = window.fetch.bind(window);
  window.fetch = ((input, init) => {
    if (isSessionAsk(input, init)) awaitingRelease.shift()?.();
    return send(input, init);
  }) as typeof window.fetch;
  initBotId({ protect: CHECKED_CALLS });
}
