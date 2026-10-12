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

/**
 * Other calls waiting for the check to let them go, each by the abort signal it was sent with: the
 * check passes a call's signal through with it, and lets calls to one path go in any order.
 */
const awaitingCall = new WeakMap<AbortSignal, () => void>();

/** The fetch the check found when it started: one that sends a call past it. */
let unchecked: typeof fetch | null = null;

/** A call's path. */
function pathOf(input: Parameters<typeof fetch>[0]): string {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url, 'http://localhost').pathname;
}

/**
 * Resolves when the browser check lets the call sent with `signal` go to the server, even one the
 * caller has stopped waiting for. The session times the check's hold on a checked call from here,
 * as it does an ask's. Never resolves where the check does not run.
 */
export function callReleased(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    awaitingCall.set(signal, resolve);
  });
}

/** Lets go the call sent with `signal`, if one is waiting. */
function releaseCall(signal: AbortSignal | null | undefined): void {
  const release = signal ? awaitingCall.get(signal) : undefined;
  if (!signal || !release) return;
  awaitingCall.delete(signal);
  release();
}

/**
 * Calls `listener` whenever the check starts its challenge afresh: it does so when the browser comes
 * back online and when the page is shown again, so a check that failed may run from then on.
 */
export function onCheckReset(listener: () => void): void {
  if (typeof window === 'undefined') return;
  const reset = () => {
    if (!document.hidden) listener();
  };
  window.addEventListener('online', reset);
  window.addEventListener('visibilitychange', reset);
}

/** Sends a call past the browser check, for one the check cannot let go: the server then decides it without a challenge. */
export function fetchUnchecked(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return (unchecked ?? globalThis.fetch)(input, init);
}

/** Whether a fetch is the session ask. */
function isSessionAsk(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): boolean {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  return method === 'POST' && pathOf(input) === SESSION_PATH;
}

/**
 * Starts the browser check once per document, ahead of the page's first checked call: from a root
 * effect, and from the session's fetch before a company data call, which a page can make before
 * its effects run. /download preview iframes run it too: their company pages load their data
 * through the same checked call.
 *
 * The check keeps the fetch it finds when it starts and sends each call it held through it, so a
 * wrapper put in first sees a session ask (`sessionAskReleased`), or any other call
 * (`callReleased`), the moment it leaves.
 */
export function initBrowserCheck(): void {
  if (started) return;
  started = true;
  if (typeof window === 'undefined') return;
  const send = window.fetch.bind(window);
  unchecked = send;
  window.fetch = ((input, init) => {
    if (isSessionAsk(input, init)) awaitingRelease.shift()?.();
    else
      releaseCall(
        init?.signal ?? (input instanceof Request ? input.signal : null),
      );
    return send(input, init);
  }) as typeof window.fetch;
  initBotId({ protect: CHECKED_CALLS });
}
