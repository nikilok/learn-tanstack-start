import { isDesktopPreview } from '../../utils/desktop-preview';
import { initBrowserCheck } from '../device/browser-check';
import {
  SESSION_HEADER,
  SESSION_HINT_COOKIE,
  SESSION_PATH,
  SESSION_REQUIRED,
} from './calls';

/** What one ask for a session came back with; `failed` is no answer at all. */
export type SessionOutcome = 'ok' | 'refused' | 'off' | 'failed';

/** Asks before giving up; the pause before the next ask grows by RETRY_MS each time. */
const ATTEMPTS = 3;
const RETRY_MS = 1000;

/** A hint expiring within this is no sign of a session. */
const HINT_MARGIN_MS = 60_000;

/** How long a /download preview frame waits for its page's session, and how often it looks. */
const PREVIEW_WAIT_MS = 3000;
const PREVIEW_POLL_MS = 250;

export type SessionDeps = {
  ask: () => Promise<SessionOutcome>;
  wait: (ms: number) => Promise<void>;
  /** The session's expiry from the readable hint cookie, in epoch seconds, or null. */
  hintExpiry: () => number | null;
  /** A /download preview frame: it shares its page's cookies and never asks itself. */
  preview: () => boolean;
  now: () => number;
  fetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>;
  /** Starts the browser check, which must stand in front of the first ask. */
  startCheck: () => void;
};

/**
 * This document's session: asked for once per load, and again when a call comes back refused for
 * want of one. Calls never wait for it up front, so a page whose calls need no session — the
 * switch off, or a session already held — pays nothing for it.
 */
export function createSession(deps: SessionDeps) {
  let first: Promise<boolean> | null = null;
  let firstPending = false;
  let renewing: Promise<boolean> | null = null;

  /** Asks until a session is held, none is being issued, or the attempts run out. */
  const obtain = async (): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      const outcome = await deps.ask();
      if (outcome === 'ok') return true;
      if (outcome === 'off' || attempt >= ATTEMPTS) return false;
      await deps.wait(RETRY_MS * attempt);
    }
  };

  const hintHeld = () => {
    const expiry = deps.hintExpiry();
    return expiry !== null && expiry * 1000 > deps.now() + HINT_MARGIN_MS;
  };

  /** A preview frame's session is its page's: it waits for the page's hint to appear. */
  const pageSession = async (): Promise<boolean> => {
    for (let waited = 0; waited < PREVIEW_WAIT_MS; waited += PREVIEW_POLL_MS) {
      if (hintHeld()) return true;
      await deps.wait(PREVIEW_POLL_MS);
    }
    return hintHeld();
  };

  /** Starts this document's ask, once; later calls return the same promise. */
  const start = (): Promise<boolean> => {
    if (first) return first;
    if (deps.preview()) {
      first = Promise.resolve(true);
      return first;
    }
    deps.startCheck();
    firstPending = true;
    first = obtain().finally(() => {
      firstPending = false;
    });
    return first;
  };

  /** Asks again after a refusal, joining an ask already in flight. */
  const renew = (): Promise<boolean> => {
    if (deps.preview()) return pageSession();
    if (firstPending && first) return first;
    renewing ??= obtain().finally(() => {
      renewing = null;
    });
    return renewing;
  };

  /** The fetch every server function call makes from the browser (`start.ts`). */
  const sessionFetch: SessionDeps['fetch'] = async (input, init) => {
    void start();
    const response = await deps.fetch(input, init);
    if (
      response.status !== 403 ||
      response.headers.get(SESSION_HEADER) !== SESSION_REQUIRED
    )
      return response;
    if (!(await renew())) return response;
    return deps.fetch(input, init);
  };

  return { start, renew, fetch: sessionFetch };
}

/** One ask of the session endpoint. */
async function askForSession(): Promise<SessionOutcome> {
  try {
    const response = await fetch(SESSION_PATH, { method: 'POST' });
    if (!response.ok) return 'failed';
    const { session } = (await response.json()) as { session?: unknown };
    return session === 'ok' || session === 'refused' || session === 'off'
      ? session
      : 'failed';
  } catch {
    return 'failed';
  }
}

function readHintExpiry(): number | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === SESSION_HINT_COOKIE) {
      const expiry = Number(part.slice(eq + 1).trim());
      return Number.isFinite(expiry) && expiry > 0 ? expiry : null;
    }
  }
  return null;
}

const session = createSession({
  ask: askForSession,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hintExpiry: readHintExpiry,
  preview: () => typeof window !== 'undefined' && isDesktopPreview(),
  now: () => Date.now(),
  // Read at call time: the browser check wraps the global fetch once it starts.
  fetch: (input, init) => globalThis.fetch(input, init),
  startCheck: initBrowserCheck,
});

/** Starts this document's session, from a root effect. Safe to call more than once, and a no-op on the server. */
export function startSession(): void {
  if (typeof window === 'undefined') return;
  void session.start();
}

/** The fetch the app's server function calls make in the browser (`start.ts`). */
export const sessionFetch = session.fetch;
