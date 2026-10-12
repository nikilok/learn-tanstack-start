import { isDesktopPreview } from '../../utils/desktop-preview';
import {
  callReleased,
  fetchUnchecked,
  initBrowserCheck,
  sessionAskReleased,
} from '../device/browser-check';
import {
  SESSION_CALL_PATH,
  SESSION_HEADER,
  SESSION_HINT_COOKIE,
  SESSION_PATH,
  SESSION_RENEW_SECONDS,
  SESSION_REQUIRED,
} from './calls';

/** What one ask for a session came back with; `failed` is no answer at all. */
export type SessionOutcome = 'ok' | 'refused' | 'off' | 'failed';

/** One ask: its answer, and the moment the browser check lets it go to the server. */
export type SessionAsk = {
  answer: Promise<SessionOutcome>;
  released: Promise<void>;
};

/**
 * What asking came to: a session (`ok`), a definite no (`none`), or no answer yet (`stalled`) — the
 * check let the ask go and the server has not answered, so it may still land.
 */
type Got = 'ok' | 'none' | 'stalled';

/** A call refused for want of a session that could not be had: the page cannot load its data. */
export class SessionRequiredError extends Error {
  constructor() {
    super('Session required');
    this.name = 'SessionRequiredError';
  }
}

/** Retries a query behind a session call takes, as React Query's default does. */
const QUERY_RETRIES = 3;

/**
 * A query's `retry` for a session call: a refusal is final, as the call has already asked for a
 * session again before giving up, so only another failure is retried.
 */
export function retrySessionCall(
  failureCount: number,
  error: unknown,
): boolean {
  return (
    !(error instanceof SessionRequiredError) && failureCount < QUERY_RETRIES
  );
}

/** Asks before giving up; the pause before the next ask grows by RETRY_MS each time. */
const ATTEMPTS = 3;
const RETRY_MS = 1000;

/** How long the server has to answer an ask, from when the browser check lets it go. */
const ANSWER_TIMEOUT_MS = 10_000;

/**
 * How long the browser check may hold an ask before it is taken to be stuck. The check holds each
 * ask until its challenge has run, which takes far longer on a slow device than on most; past this
 * it is not coming.
 */
const HOLD_LIMIT_MS = 60_000;

/** A hint expiring within this is no sign of a session. */
const HINT_MARGIN_MS = 60_000;

/**
 * How long a /download preview frame waits for its page's session, and how often it looks: as
 * long as the page's ask may take, since the frame's session is the one that ask gets.
 */
const PREVIEW_WAIT_MS = HOLD_LIMIT_MS + ANSWER_TIMEOUT_MS;
const PREVIEW_POLL_MS = 250;

export type SessionDeps = {
  ask: () => SessionAsk;
  wait: (ms: number) => Promise<void>;
  /** Resolves after `ms`: the deadlines an ask races. */
  timeout: (ms: number) => Promise<void>;
  /** The session's expiry from the readable hint cookie, in epoch seconds, or null. */
  hintExpiry: () => number | null;
  /** A /download preview frame: it shares its page's cookies and never asks itself. */
  preview: () => boolean;
  now: () => number;
  fetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>;
  /** When the browser check lets a call go, and a way to stop waiting for it (`callReleased`). */
  released: (input: Parameters<typeof fetch>[0]) => {
    released: Promise<void>;
    forget: () => void;
  };
  /** Sends a call past the browser check, which the server then decides without a challenge. */
  fetchUnchecked: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>;
  /** Starts the browser check, which must stand in front of the first ask. */
  startCheck: () => void;
};

/**
 * This document's session: asked for on load unless one with time to run is held, and again when
 * a call is refused for want of one. Only a session call made with no session held waits for the
 * first ask; every other call goes out at once.
 */
export function createSession(deps: SessionDeps) {
  let first: Promise<Got> | null = null;
  let firstPending = false;
  let renewing: Promise<Got> | null = null;
  /** The browser check cannot run in this document: it failed a call, or held one past its bound. */
  let checkDead = false;

  /**
   * Asks until a session is held or none can be had. The server's answer is timed from when the
   * check lets the ask go; the check's own hold has a longer bound of its own. An ask that failed
   * before the check let it go means the check itself cannot run, and asking again only waits on it.
   */
  const obtain = async (): Promise<Got> => {
    deps.startCheck();
    for (let attempt = 1; ; attempt++) {
      const ask = deps.ask();
      let released = false;
      const leaves = ask.released.then(() => {
        released = true;
      });
      const outcome = await Promise.race([
        ask.answer,
        leaves
          .then(() => deps.timeout(ANSWER_TIMEOUT_MS))
          .then(() => 'stalled' as const),
        // The hold's bound stands only while the check still holds the ask.
        deps
          .timeout(HOLD_LIMIT_MS)
          .then(() =>
            released ? new Promise<never>(() => {}) : ('held' as const),
          ),
      ]);
      if (outcome === 'ok') return 'ok';
      if (outcome === 'stalled') return 'stalled';
      if (outcome === 'held' || (outcome === 'failed' && !released)) {
        checkDead = true;
        return 'none';
      }
      if (outcome === 'off' || attempt >= ATTEMPTS) return 'none';
      await deps.wait(RETRY_MS * attempt);
    }
  };

  /** Whether the hint shows a session with more than `marginMs` left. */
  const hintLeft = (marginMs: number) => {
    const expiry = deps.hintExpiry();
    return expiry !== null && expiry * 1000 > deps.now() + marginMs;
  };
  /** Whether the hint shows a session that has not run out. */
  const hintHeld = () => hintLeft(HINT_MARGIN_MS);

  /** A preview frame's session is its page's: it waits for the page's hint to appear. */
  const pageSession = async (): Promise<Got> => {
    for (let waited = 0; waited < PREVIEW_WAIT_MS; waited += PREVIEW_POLL_MS) {
      if (hintHeld()) return 'ok';
      await deps.wait(PREVIEW_POLL_MS);
    }
    return hintHeld() ? 'ok' : 'none';
  };

  /** Starts this document's ask, once; later calls return the same promise. */
  const start = (): Promise<Got> => {
    if (first) return first;
    // A preview frame shares its page's session, and a session with time to run needs no ask: a
    // call refused anyway (the address moved) renews it then.
    if (deps.preview() || hintLeft(SESSION_RENEW_SECONDS * 1000)) {
      first = Promise.resolve<Got>('ok');
      return first;
    }
    firstPending = true;
    first = obtain().finally(() => {
      firstPending = false;
    });
    return first;
  };

  /** Asks again after a refusal, joining an ask already in flight. */
  const renew = (): Promise<Got> => {
    if (deps.preview()) return pageSession();
    if (firstPending && first) return first;
    renewing ??= obtain().finally(() => {
      renewing = null;
    });
    return renewing;
  };

  /**
   * A company data call, sent through the browser check, whose hold on it is bounded as an ask's
   * is. A call the check cannot let go (its script failed, which it reports with an event rather
   * than an error, or it held the call past the bound) goes out past the check instead, for the
   * server to decide without a challenge; once that happens, every later call in this document
   * does so at once.
   */
  const sendChecked: SessionDeps['fetch'] = async (input, init) => {
    if (checkDead) return deps.fetchUnchecked(input, init);
    const { released, forget } = deps.released(input);
    let left = false;
    void released.then(() => {
      left = true;
    });
    try {
      const outcome = await Promise.race([
        deps.fetch(input, init).catch((error: unknown) => {
          if (error instanceof Error) throw error;
          return 'failed' as const;
        }),
        deps
          .timeout(HOLD_LIMIT_MS)
          .then(() =>
            left ? new Promise<never>(() => {}) : ('held' as const),
          ),
      ]);
      if (outcome instanceof Response) return outcome;
      checkDead = true;
      return deps.fetchUnchecked(input, init);
    } finally {
      forget();
    }
  };

  /**
   * The fetch every server function call makes from the browser (`start.ts`). A company data call
   * starts the browser check first, as it carries the check's challenge, and a page can make one
   * before the root effect that starts the check has run (`sendChecked`); a search listing's call
   * carries none, and goes as it is. A session call made while the first ask is out, with no
   * session held, waits for it instead of being refused and sent again. A first ask whose answer
   * stalled may still land, so the call asks again before it goes; only a definite no makes its
   * refusal final. A refusal that stands after renewing throws `SessionRequiredError`, a named
   * failure the page can report.
   */
  const sessionFetch: SessionDeps['fetch'] = async (input, init) => {
    const asked = start();
    const sessionCall = isSessionCall(input);
    const companyData = sessionCall && isPost(input, init);
    if (companyData) deps.startCheck();
    const send = companyData ? sendChecked : deps.fetch;
    let waited =
      firstPending && !hintHeld() && sessionCall ? await asked : null;
    if (waited === 'stalled' && !hintHeld()) waited = await renew();
    const response = await send(input, init);
    if (!refused(response)) return response;
    if (waited !== 'none' && (await renew()) === 'ok') {
      const again = await send(input, init);
      if (!refused(again)) return again;
    }
    throw new SessionRequiredError();
  };

  return { start, renew, fetch: sessionFetch };
}

/** Whether a call is a session call (`SESSION_CALLS`), the only kind refused without a session. */
function isSessionCall(input: Parameters<typeof fetch>[0]): boolean {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url, 'http://localhost').pathname.startsWith(
    SESSION_CALL_PATH,
  );
}

/** Whether a call is a POST: a session call sent so is a company page's, which the browser check stands in front of (`CHECKED_CALLS`). */
function isPost(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): boolean {
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase() === 'POST';
}

/** A refusal for want of a session (`middleware.ts`). */
function refused(response: Response): boolean {
  return (
    response.status === 403 &&
    response.headers.get(SESSION_HEADER) === SESSION_REQUIRED
  );
}

/** One ask of the session endpoint. */
function askForSession(): SessionAsk {
  const released = sessionAskReleased();
  const answer = (async (): Promise<SessionOutcome> => {
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
  })();
  return { answer, released };
}

/** The session's expiry from the readable hint cookie, in epoch seconds, or null. */
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

/** Resolves after `ms`. */
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const session = createSession({
  ask: askForSession,
  wait: delay,
  timeout: delay,
  hintExpiry: readHintExpiry,
  preview: () => typeof window !== 'undefined' && isDesktopPreview(),
  now: () => Date.now(),
  // Read at call time: the browser check wraps the global fetch once it starts.
  fetch: (input, init) => globalThis.fetch(input, init),
  released: (input) =>
    callReleased(
      new URL(
        input instanceof Request ? input.url : String(input),
        'http://localhost',
      ).pathname,
    ),
  fetchUnchecked,
  startCheck: initBrowserCheck,
});

/** Starts this document's session, from a root effect. Safe to call more than once, and a no-op on the server. */
export function startSession(): void {
  if (typeof window === 'undefined') return;
  void session.start();
}

/** The fetch the app's server function calls make in the browser (`start.ts`). */
export const sessionFetch = session.fetch;
