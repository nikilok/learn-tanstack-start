import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SESSION_RENEW_SECONDS } from './calls';
import {
  createAsk,
  createSession,
  KEY_WAIT_MS,
  retrySessionCall,
  type SessionDeps,
  type SessionOutcome,
  SessionRequiredError,
} from './client';

/** The edge's refusal for want of a session. */
const refused = () =>
  new Response(null, { status: 403, headers: { 'x-session': 'required' } });
/** A call answered. */
const answered = () => new Response('{}', { status: 200 });
/** A company data call is a POST, which the browser check stands in front of; a search listing's is a GET. */
const PAGE_CALL = { method: 'POST' } as const;
const NOW = 1_800_000_000_000;

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Virtual time: every pause, deadline, hold and answer runs on it, and nothing waits for real. */
class Clock {
  now = 0;
  private queue: { at: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;

  sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms)) return new Promise(() => {});
    return new Promise((resolve) =>
      this.queue.push({ at: this.now + ms, seq: this.seq++, resolve }),
    );
  }

  /** Runs time forward to `until`, or until nothing is left scheduled. */
  async run(until = Number.POSITIVE_INFINITY) {
    for (;;) {
      await flush();
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.queue[0];
      if (!next || next.at > until) break;
      this.queue.shift();
      this.now = next.at;
      next.resolve();
    }
    await flush();
  }
}

/** One scripted ask: what it answers, how long the check holds it, and how long the server takes. */
type Ask = {
  outcome: SessionOutcome;
  /** Before it is sent, as when it waits for its device key. */
  sendMs?: number;
  /** Before the check lets it go; `Infinity`, never. */
  holdMs?: number;
  /** Once it is let go; `Infinity`, never answers. */
  serverMs?: number;
  /** It fails while the check still holds it: the check itself cannot run. */
  failsHeld?: boolean;
};

/** How the browser check treats the POST calls sent through it, oldest first. */
type Checked = {
  /** Before the check lets the call go; `Infinity`, never. */
  holdMs?: number;
  /** The check fails the call while holding it, as it does when its script failed: with an event, not an error. */
  failsHeld?: boolean;
  /** Once it is let go, before the server answers. */
  serverMs?: number;
};

/** A session over scripted asks and responses, on virtual time, recording what it did. */
function harness(options: {
  asks?: Array<SessionOutcome | Ask>;
  responses?: Array<() => Response>;
  /** Answers each call as the edge would: refused until an ask has landed a session. */
  edge?: boolean;
  preview?: boolean;
  hint?: () => number | null;
  /** Called on every pause, before it runs. */
  onWait?: (ms: number) => void;
  /** The check's treatment of each POST call sent through it; let go at once otherwise. */
  checked?: Checked[];
}) {
  const clock = new Clock();
  const asks = (options.asks ?? []).map((a) =>
    typeof a === 'string' ? { outcome: a } : a,
  );
  const responses = [...(options.responses ?? [])];
  const checked = [...(options.checked ?? [])];
  const log: string[] = [];
  let landed = false;
  /** The calls waiting for the check to let them go, by the signal each was sent with. */
  const waiting = new Map<AbortSignal, () => void>();
  let sentThroughCheck = 0;
  /** What the session asked to hear when the check starts afresh. */
  const resets: Array<() => void> = [];
  /** The next scripted answer to a call that reached the server. */
  const answer = () => {
    const next = options.edge
      ? landed
        ? answered
        : refused
      : responses.shift();
    if (!next) throw new Error('no response scripted');
    return next();
  };
  const deps: SessionDeps = {
    ask: () => {
      const a = asks.shift() ?? { outcome: 'failed' };
      log.push(`ask:${a.outcome}`);
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markSent = () => {};
      const sent = new Promise<void>((resolve) => {
        markSent = resolve;
      });
      const answer = (async (): Promise<SessionOutcome> => {
        if (a.sendMs) await clock.sleep(a.sendMs);
        markSent();
        if (a.holdMs) await clock.sleep(a.holdMs);
        if (a.failsHeld) {
          log.push('answer:failed');
          return 'failed';
        }
        release();
        log.push('left');
        if (a.serverMs) await clock.sleep(a.serverMs);
        if (a.outcome === 'ok') landed = true;
        log.push(`answer:${a.outcome}`);
        return a.outcome;
      })();
      return { answer, sent, released };
    },
    wait: async (ms) => {
      log.push(`wait:${ms}`);
      options.onWait?.(ms);
      await clock.sleep(ms);
    },
    timeout: (ms) => clock.sleep(ms),
    hintExpiry: options.hint ?? (() => null),
    preview: () => options.preview ?? false,
    now: () => NOW,
    // The check stands in front of every POST: it lets each go by the signal it carries, and a
    // call withdrawn while held never reaches the server, as `fetch` refuses an aborted signal.
    fetch: async (_input, init) => {
      if (init?.method === 'POST') {
        const treatment = checked.shift() ?? {};
        if (treatment.holdMs) await clock.sleep(treatment.holdMs);
        if (treatment.failsHeld) {
          log.push('check:failed');
          throw new Event('error');
        }
        const signal = init.signal;
        if (signal) {
          waiting.get(signal)?.();
          waiting.delete(signal);
        }
        if (signal?.aborted) {
          log.push('check:withdrawn');
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (treatment.serverMs) await clock.sleep(treatment.serverMs);
      }
      const response = answer();
      log.push(`fetch:${response.status}`);
      return response;
    },
    released: (signal) => {
      sentThroughCheck++;
      return new Promise<void>((resolve) => {
        waiting.set(signal, resolve);
      });
    },
    fetchUnchecked: async () => {
      const response = answer();
      log.push(`unchecked:${response.status}`);
      return response;
    },
    // Once per document, as `initBrowserCheck` starts it.
    startCheck: () => {
      if (!log.includes('check')) log.push('check');
    },
    onCheckReset: (listener) => {
      resets.push(listener);
    },
  };
  return {
    session: createSession(deps),
    log,
    clock,
    /** The calls sent through the browser check. */
    throughCheck: () => sentThroughCheck,
    /** The check starts its challenge afresh: the browser came back online, or the page was shown. */
    reset: () => {
      for (const listener of resets) listener();
    },
  };
}

/** Runs a call to its end on virtual time: its status or its error's name, and when it settled. */
async function settle(
  h: { clock: Clock },
  call: Promise<Response>,
): Promise<{ result: string; at: number }> {
  let result = 'pending';
  let at = -1;
  call.then(
    (r) => {
      result = String(r.status);
      at = h.clock.now;
    },
    (e: unknown) => {
      result = e instanceof Error ? e.name : String(e);
      at = h.clock.now;
    },
  );
  await h.clock.run();
  return { result, at };
}

/** The asks a session made, in order. */
const asksIn = (log: string[]) => log.filter((l) => l.startsWith('ask:'));
/** The calls the edge refused. */
const refusalsIn = (log: string[]) => log.filter((l) => l === 'fetch:403');

describe('createSession', () => {
  test('a call goes out at once, and starts the session behind it', async () => {
    const h = harness({ asks: ['ok'], responses: [answered] });
    expect(await settle(h, h.session.fetch('/_serverFn/abc'))).toEqual({
      result: '200',
      at: 0,
    });
    expect(h.log.slice(0, 2)).toEqual(['check', 'ask:ok']);
    expect(h.log).toContain('fetch:200');
  });

  test.each([
    ['a path', '/_serverFn/s-abc'],
    ['a URL', new URL('https://example.test/_serverFn/s-abc')],
  ] as const)(
    'a company data call given as %s, made with no session, waits for the first ask and goes once',
    async (_, input) => {
      const h = harness({
        asks: [{ outcome: 'ok', holdMs: 5000 }],
        responses: [answered],
      });
      const call = h.session.fetch(input, PAGE_CALL);
      await h.clock.run(4999);
      expect(h.log).not.toContain('fetch:200');
      expect(await settle(h, call)).toEqual({ result: '200', at: 5000 });
      expect(h.log).toEqual([
        'check',
        'ask:ok',
        'left',
        'answer:ok',
        'fetch:200',
      ]);
    },
  );

  test('any other call goes out while the first ask is still out', async () => {
    const h = harness({
      asks: [{ outcome: 'ok', holdMs: 5000 }],
      responses: [answered],
    });
    expect(await settle(h, h.session.fetch('/_serverFn/abc'))).toEqual({
      result: '200',
      at: 0,
    });
  });

  test('with a session that has not run out, a company data call does not wait for its renewal', async () => {
    const ending = NOW / 1000 + SESSION_RENEW_SECONDS - 3600;
    const h = harness({
      asks: [{ outcome: 'ok', holdMs: 5000 }],
      responses: [answered],
      hint: () => ending,
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: 0,
    });
    expect(h.log.slice(0, 3)).toEqual(['check', 'ask:ok', 'fetch:200']);
  });

  test('a call refused after the first ask got a session renews once, then goes again', async () => {
    const h = harness({ asks: ['ok', 'ok'], responses: [refused, answered] });
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL))).result,
    ).toBe('200');
    expect(asksIn(h.log)).toEqual(['ask:ok', 'ask:ok']);
    expect(h.log.filter((l) => l.startsWith('fetch:'))).toHaveLength(2);
  });

  test('a refusal after the first ask settled asks again', async () => {
    const h = harness({ asks: ['ok', 'ok'], responses: [refused, answered] });
    void h.session.start();
    await h.clock.run();
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL))).result,
    ).toBe('200');
    expect(asksIn(h.log)).toEqual(['ask:ok', 'ask:ok']);
  });

  test('a refused ask is tried three times, pausing longer each time, then the call fails by name without a second round', async () => {
    const h = harness({
      asks: ['refused', 'refused', 'refused'],
      responses: [refused],
    });
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL))).result,
    ).toBe('SessionRequiredError');
    expect(
      h.log.filter((l) => l.startsWith('ask:') || l.startsWith('wait:')),
    ).toEqual([
      'ask:refused',
      'wait:1000',
      'ask:refused',
      'wait:2000',
      'ask:refused',
    ]);
    expect(h.log.filter((l) => l.startsWith('fetch:'))).toHaveLength(1);
  });

  test('a call refused again after renewing fails by name, not with the bare response', async () => {
    const h = harness({ asks: ['ok', 'ok'], responses: [refused, refused] });
    await expect(
      Promise.all([
        h.session.fetch('/_serverFn/s-abc', PAGE_CALL),
        h.clock.run(),
      ]),
    ).rejects.toBeInstanceOf(SessionRequiredError);
  });

  test('off is final: no retries, and the call is not made again', async () => {
    const h = harness({ asks: ['off'], responses: [refused] });
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL))).result,
    ).toBe('SessionRequiredError');
    expect(asksIn(h.log)).toEqual(['ask:off']);
    expect(h.log.filter((l) => l.startsWith('fetch:'))).toHaveLength(1);
  });

  test('a response that is not a session refusal is returned as it came', async () => {
    const forbidden = () => new Response(null, { status: 403 });
    const h = harness({ asks: ['ok'], responses: [forbidden] });
    expect((await settle(h, h.session.fetch('/_serverFn/abc'))).result).toBe(
      '403',
    );
    expect(h.log.filter((l) => l.startsWith('fetch:'))).toHaveLength(1);
  });

  test('the first ask is made once, however many calls start it', async () => {
    const h = harness({ asks: ['ok'], responses: [answered, answered] });
    void h.session.fetch('/a');
    void h.session.fetch('/b');
    void h.session.start();
    await h.clock.run();
    expect(h.log.filter((l) => l === 'check')).toHaveLength(1);
    expect(asksIn(h.log)).toHaveLength(1);
  });

  test('a held session with time to run is not asked for on load', async () => {
    const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;
    const h = harness({ responses: [answered], hint: () => fresh });
    void h.session.start();
    expect((await settle(h, h.session.fetch('/_serverFn/abc'))).result).toBe(
      '200',
    );
    expect(asksIn(h.log)).toEqual([]);
    expect(h.log).not.toContain('check');
  });

  test('with a held session, a company data call starts the browser check before it goes', async () => {
    const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;
    const h = harness({ responses: [answered], hint: () => fresh });
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL))).result,
    ).toBe('200');
    expect(h.log).toEqual(['check', 'fetch:200']);
  });

  test('a held session near its end is asked for on load, and a refused call still renews', async () => {
    const ending = NOW / 1000 + SESSION_RENEW_SECONDS - 3600;
    const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;
    const near = harness({ asks: ['ok'], hint: () => ending });
    void near.session.start();
    await near.clock.run();
    expect(asksIn(near.log)).toEqual(['ask:ok']);
    const moved = harness({
      asks: ['ok'],
      responses: [refused, answered],
      hint: () => fresh,
    });
    expect(
      (await settle(moved, moved.session.fetch('/_serverFn/s-abc', PAGE_CALL)))
        .result,
    ).toBe('200');
    expect(asksIn(moved.log)).toEqual(['ask:ok']);
  });
});

// A search listing's call is a GET: the edge wants a session for it, and the browser check stands in
// front of none.
describe('createSession — a search listing call', () => {
  test('made with no session, it waits for the first ask and goes once, past no check of its own', async () => {
    const h = harness({
      asks: [{ outcome: 'ok', holdMs: 5000 }],
      responses: [answered],
    });
    const call = h.session.fetch('/_serverFn/s-abc');
    await h.clock.run(4999);
    expect(h.log).not.toContain('fetch:200');
    expect(await settle(h, call)).toEqual({ result: '200', at: 5000 });
    expect(h.log).toEqual([
      'check',
      'ask:ok',
      'left',
      'answer:ok',
      'fetch:200',
    ]);
    expect(h.throughCheck()).toBe(0);
  });

  test('with a session held, it goes at once and starts no check', async () => {
    const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;
    const h = harness({ responses: [answered], hint: () => fresh });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', { method: 'GET' })),
    ).toEqual({ result: '200', at: 0 });
    expect(h.log).toEqual(['fetch:200']);
    expect(h.throughCheck()).toBe(0);
  });

  test('refused after the first ask got a session, it renews once and goes again', async () => {
    const h = harness({ asks: ['ok', 'ok'], responses: [refused, answered] });
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      '200',
    );
    expect(asksIn(h.log)).toEqual(['ask:ok', 'ask:ok']);
    expect(refusalsIn(h.log)).toHaveLength(1);
  });

  test('where no session can be had, it fails by name', async () => {
    const h = harness({
      asks: ['refused', 'refused', 'refused'],
      responses: [refused],
    });
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      'SessionRequiredError',
    );
  });

  test('once the check is dead, it still goes as it is, not past the check', async () => {
    const h = harness({
      asks: ['ok'],
      responses: [answered, answered],
      checked: [{ failsHeld: true }],
    });
    await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL));
    expect((await settle(h, h.session.fetch('/_serverFn/s-def'))).result).toBe(
      '200',
    );
    expect(h.log.filter((l) => /^(unchecked|fetch)/.test(l))).toEqual([
      'unchecked:200',
      'fetch:200',
    ]);
  });
});

describe('retrySessionCall', () => {
  test('a refusal is never retried: the call has already asked for a session again', () => {
    for (const failures of [0, 1, 2])
      expect(retrySessionCall(failures, new SessionRequiredError())).toBe(
        false,
      );
  });

  test('any other failure is retried three times', () => {
    expect(
      [0, 1, 2, 3].map((failures) =>
        retrySessionCall(failures, new Error('Network error')),
      ),
    ).toEqual([true, true, true, false]);
  });

  test.each(['useHmrcSearch.ts', 'useFilterSearch.ts'])(
    '%s retries by it, and reads its state through listingState',
    (file) => {
      const source = readFileSync(
        join(import.meta.dir, '../../hooks', file),
        'utf8',
      );
      expect(source).toContain('retry: retrySessionCall,');
      expect(source).toContain('...listingState({');
    },
  );
});

// The browser check holds the session ask until its challenge has run, and a slow device takes far
// longer than most. Only the server's leg is timed tightly, from when the check lets the ask go.
describe('createSession — a slow or stuck browser check', () => {
  test.each([15_000, 45_000])(
    'a check that holds the first ask %i ms still gets the waiting company call its session: one ask, no refusal',
    async (holdMs) => {
      const h = harness({ asks: [{ outcome: 'ok', holdMs }], edge: true });
      expect(
        await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
      ).toEqual({
        result: '200',
        at: holdMs,
      });
      expect(asksIn(h.log)).toHaveLength(1);
      expect(refusalsIn(h.log)).toEqual([]);
    },
  );

  test("the hold's bound is timed from when the ask is sent: one that waited for its key and was let go just before the bound still counts", async () => {
    const h = harness({
      asks: [{ outcome: 'ok', sendMs: 3000, holdMs: 58_000, serverMs: 1000 }],
      edge: true,
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: 62_000,
    });
  });

  test('an ask let go just before the hold bound and answered just after it still counts', async () => {
    const h = harness({
      asks: [{ outcome: 'ok', holdMs: 59_000, serverMs: 2000 }],
      edge: true,
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: 61_000,
    });
  });

  test('the server answer is timed from release: one that hangs past it stalls, and the call asks again before it goes', async () => {
    const h = harness({
      asks: [
        { outcome: 'ok', holdMs: 15_000, serverMs: Number.POSITIVE_INFINITY },
        'ok',
      ],
      edge: true,
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: 25_000,
    });
    expect(asksIn(h.log)).toHaveLength(2);
    expect(refusalsIn(h.log)).toEqual([]);
  });

  test('a check that fails before it lets the ask go is not asked again: the call fails by name at once', async () => {
    const h = harness({
      asks: [{ outcome: 'failed', failsHeld: true }],
      edge: true,
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: 'SessionRequiredError',
      at: 0,
    });
    expect(asksIn(h.log)).toHaveLength(1);
    expect(h.log.some((l) => l.startsWith('wait:'))).toBe(false);
  });

  test('a failure after the check let the ask go is tried again', async () => {
    const h = harness({ asks: ['failed', 'ok'], edge: true });
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL))).result,
    ).toBe('200');
    expect(asksIn(h.log)).toEqual(['ask:failed', 'ask:ok']);
    expect(h.log).toContain('wait:1000');
  });

  test('a check that never lets the ask go is given up at its bound: the call fails by name, never hangs', async () => {
    const h = harness({
      asks: [{ outcome: 'ok', holdMs: Number.POSITIVE_INFINITY }],
      edge: true,
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: 'SessionRequiredError',
      at: 60_000,
    });
    expect(asksIn(h.log)).toHaveLength(1);
  });
});

// The check holds every POST call (a company page's data among them) until its challenge has run,
// as it does an ask. Its hold is bounded the same way, and a check that cannot run sends the call
// past itself, for the server to decide, rather than leaving the page waiting with nothing sent.
describe('createSession — a call the check holds', () => {
  const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;

  test('a call held past the bound goes out past the check, and is answered', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered],
      checked: [{ holdMs: Number.POSITIVE_INFINITY }],
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: 60_000,
    });
    expect(h.log).toContain('unchecked:200');
  });

  test('a call let go just before the bound and answered after it still goes through the check', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered],
      checked: [{ holdMs: 59_000, serverMs: 2000 }],
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: 61_000,
    });
    expect(h.log.filter((l) => l.startsWith('unchecked'))).toEqual([]);
  });

  test('a call the check fails (its script failed) goes out past it at once, and so does every later one while it cannot run', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered, answered],
      checked: [{ failsHeld: true }, {}],
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: 0,
    });
    // The first call's unspent bound has run the clock on; the later call adds no wait of its own.
    const later = h.clock.now;
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-def', PAGE_CALL)),
    ).toEqual({
      result: '200',
      at: later,
    });
    expect(h.log.filter((l) => /^(check:|unchecked|fetch)/.test(l))).toEqual([
      'check:failed',
      'unchecked:200',
      'unchecked:200',
    ]);
  });

  test('an ask the check fails sends the company call past the check, where the edge still wants a session', async () => {
    const h = harness({
      asks: [{ outcome: 'failed', failsHeld: true }],
      edge: true,
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: 'SessionRequiredError',
      at: 0,
    });
    expect(h.log).toContain('unchecked:403');
  });

  test('a call the check fails with an error is that error, not a dead check: the next goes through it', async () => {
    const offline = () => {
      throw new TypeError('Failed to fetch');
    };
    const h = harness({ hint: () => fresh, responses: [offline, answered] });
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL))).result,
    ).toBe('TypeError');
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-def', PAGE_CALL))).result,
    ).toBe('200');
    expect(h.log.filter((l) => /^(unchecked|fetch)/.test(l))).toEqual([
      'fetch:200',
    ]);
    expect(h.throughCheck()).toBe(2);
  });

  test('a call held past the bound is withdrawn from the check: let go late, it is not sent again, and later calls go through the check', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered, answered],
      checked: [{ holdMs: 65_000 }, {}],
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({ result: '200', at: 60_000 });
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-def', PAGE_CALL))).result,
    ).toBe('200');
    expect(h.log.filter((l) => /^(check:|unchecked|fetch)/.test(l))).toEqual([
      'unchecked:200',
      'check:withdrawn',
      'fetch:200',
    ]);
  });

  test('after the check fails, a call goes through it again once it starts afresh', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered, answered, answered],
      checked: [{ failsHeld: true }, {}],
    });
    await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL));
    await settle(h, h.session.fetch('/_serverFn/s-def', PAGE_CALL));
    h.reset();
    expect(
      (await settle(h, h.session.fetch('/_serverFn/s-ghi', PAGE_CALL))).result,
    ).toBe('200');
    expect(h.log.filter((l) => /^(check:|unchecked|fetch)/.test(l))).toEqual([
      'check:failed',
      'unchecked:200',
      'unchecked:200',
      'fetch:200',
    ]);
  });

  test('a POST call that is no session call is bounded the same way', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered],
      checked: [{ holdMs: Number.POSITIVE_INFINITY }],
    });
    expect(
      await settle(h, h.session.fetch('/_serverFn/abc', PAGE_CALL)),
    ).toEqual({ result: '200', at: 60_000 });
    expect(h.log).toContain('unchecked:200');
  });

  test('two calls to one path are each let go by their own release', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered, answered],
      checked: [{ holdMs: Number.POSITIVE_INFINITY }, { holdMs: 1000 }],
    });
    const stuck = settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL));
    const quick = settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL));
    expect(await quick).toEqual({ result: '200', at: 1000 });
    expect(await stuck).toEqual({ result: '200', at: 60_000 });
    expect(h.log.filter((l) => /^(unchecked|fetch)/.test(l))).toEqual([
      'fetch:200',
      'unchecked:200',
    ]);
  });
});

// A check that cannot run holds every ask until its bound: no ask is made while it cannot, so a
// refused call fails at once rather than waiting on one, until the check starts afresh.
describe('createSession — a check that cannot run', () => {
  test('a refused call asks for no session while the check cannot run, and does again once it starts afresh', async () => {
    const h = harness({
      asks: [{ outcome: 'failed', failsHeld: true }, 'ok'],
      edge: true,
    });
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: 'SessionRequiredError',
      at: 0,
    });
    const later = h.clock.now;
    expect(await settle(h, h.session.fetch('/_serverFn/s-def'))).toEqual({
      result: 'SessionRequiredError',
      at: later,
    });
    expect(asksIn(h.log)).toEqual(['ask:failed']);
    h.reset();
    expect((await settle(h, h.session.fetch('/_serverFn/s-ghi'))).result).toBe(
      '200',
    );
    expect(asksIn(h.log)).toEqual(['ask:failed', 'ask:ok']);
  });
});

describe('createSession — a /download preview frame', () => {
  // A frame never asks: it waits, polling, for its page's session, as long as the page's ask may
  // take — a page whose check is slow lends its session late.
  test.each([2, 200])(
    'a refused call waits until its page holds a session (%i polls), and never asks: it only starts the browser check',
    async (polls) => {
      let hint: number | null = null;
      let seen = 0;
      const h = harness({
        preview: true,
        responses: [refused, answered],
        hint: () => hint,
        onWait: (ms) => {
          if (ms === 250 && ++seen === polls) hint = NOW / 1000 + 86_400;
        },
      });
      expect(
        (await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)))
          .result,
      ).toBe('200');
      expect(h.log.filter((l) => l === 'wait:250')).toHaveLength(polls);
      expect(asksIn(h.log)).toEqual([]);
      expect(h.log[0]).toBe('check');
    },
  );

  test('a frame whose page never holds a session gives up after its wait', async () => {
    const h = harness({ preview: true, responses: [refused] });
    expect(
      await settle(h, h.session.fetch('/_serverFn/s-abc', PAGE_CALL)),
    ).toEqual({
      result: 'SessionRequiredError',
      at: 70_000,
    });
    expect(h.log.filter((l) => l.startsWith('fetch:'))).toHaveLength(1);
  });
});

describe('createAsk', () => {
  const KEY = 'a'.repeat(32);

  /** One ask over a scripted device key and answer, on virtual time, recording what it sent. */
  function asking(
    deviceKey: () => Promise<string | null>,
    answer: () => Response = () =>
      new Response(JSON.stringify({ session: 'ok' }), { status: 200 }),
  ) {
    const clock = new Clock();
    const sent: string[] = [];
    let releases = 0;
    const ask = createAsk({
      deviceKey,
      timeout: (ms) => clock.sleep(ms),
      post: async (body) => {
        sent.push(body);
        return answer();
      },
      released: () => {
        releases++;
        return new Promise(() => {});
      },
    });
    return { clock, sent, ask, releases: () => releases };
  }

  test("names the document's device key", async () => {
    const a = asking(async () => KEY);
    const { answer } = a.ask();
    await a.clock.run();
    expect(await answer).toBe('ok');
    expect(a.sent).toEqual([JSON.stringify({ key: KEY })]);
  });

  test('waits for the key up to its bound, then goes without one', async () => {
    const a = asking(() => new Promise(() => {}));
    const { answer } = a.ask();
    await a.clock.run(KEY_WAIT_MS - 1);
    expect(a.sent).toEqual([]);
    await a.clock.run();
    expect(await answer).toBe('ok');
    expect(a.sent).toEqual(['{}']);
  });

  test('a key that cannot be computed, or whose computation fails, is none', async () => {
    for (const deviceKey of [
      async () => null,
      async () => {
        throw new Error('blocked');
      },
    ]) {
      const a = asking(deviceKey);
      const { answer } = a.ask();
      await a.clock.run();
      expect(await answer).toBe('ok');
      expect(a.sent).toEqual(['{}']);
    }
  });

  test('is sent once its key arrives or its wait for one runs out, and not before', async () => {
    const a = asking(() => new Promise(() => {}));
    const ask = a.ask();
    let sent = false;
    void ask.sent?.then(() => {
      sent = true;
    });
    await a.clock.run(KEY_WAIT_MS - 1);
    expect(sent).toBe(false);
    await a.clock.run();
    expect(sent).toBe(true);
    expect(a.sent).toEqual(['{}']);
  });

  test("asks for the check's release as the ask is made, before its key arrives", () => {
    const a = asking(() => new Promise(() => {}));
    a.ask();
    expect(a.releases()).toBe(1);
    expect(a.sent).toEqual([]);
  });

  test('an answer that is not a well-formed one fails', async () => {
    for (const answer of [
      () => new Response('', { status: 500 }),
      () => new Response('not json', { status: 200 }),
      () => new Response(JSON.stringify({ session: 'maybe' }), { status: 200 }),
    ]) {
      const a = asking(async () => KEY, answer);
      const { answer: got } = a.ask();
      await a.clock.run();
      expect(await got).toBe('failed');
    }
  });
});
