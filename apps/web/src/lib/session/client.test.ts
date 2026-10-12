import { describe, expect, test } from 'bun:test';

import { SESSION_RENEW_SECONDS } from './calls';
import {
  createSession,
  type SessionDeps,
  type SessionOutcome,
  SessionRequiredError,
} from './client';

/** The edge's refusal for want of a session. */
const refused = () =>
  new Response(null, { status: 403, headers: { 'x-session': 'required' } });
/** A call answered. */
const answered = () => new Response('{}', { status: 200 });
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
  /** Before the check lets it go; `Infinity`, never. */
  holdMs?: number;
  /** Once it is let go; `Infinity`, never answers. */
  serverMs?: number;
  /** It fails while the check still holds it: the check itself cannot run. */
  failsHeld?: boolean;
};

/** How the browser check treats the company data calls sent through it, oldest first. */
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
  /** The check's treatment of each company data call sent through it; let go at once otherwise. */
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
  /** The calls waiting for the check to let them go, oldest first. */
  const waiting: Array<() => void> = [];
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
      const answer = (async (): Promise<SessionOutcome> => {
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
      return { answer, released };
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
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (
        new URL(url, 'http://localhost').pathname.startsWith('/_serverFn/s-')
      ) {
        const treatment = checked.shift() ?? {};
        if (treatment.holdMs) await clock.sleep(treatment.holdMs);
        if (treatment.failsHeld) {
          log.push('check:failed');
          throw new Event('error');
        }
        waiting.shift()?.();
        if (treatment.serverMs) await clock.sleep(treatment.serverMs);
      }
      const response = answer();
      log.push(`fetch:${response.status}`);
      return response;
    },
    released: () => {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      waiting.push(release);
      return {
        released,
        forget: () => {
          const at = waiting.indexOf(release);
          if (at !== -1) waiting.splice(at, 1);
        },
      };
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
  };
  return { session: createSession(deps), log, clock };
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
      const call = h.session.fetch(input);
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
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: '200',
      at: 0,
    });
    expect(h.log.slice(0, 3)).toEqual(['check', 'ask:ok', 'fetch:200']);
  });

  test('a call refused after the first ask got a session renews once, then goes again', async () => {
    const h = harness({ asks: ['ok', 'ok'], responses: [refused, answered] });
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      '200',
    );
    expect(asksIn(h.log)).toEqual(['ask:ok', 'ask:ok']);
    expect(h.log.filter((l) => l.startsWith('fetch:'))).toHaveLength(2);
  });

  test('a refusal after the first ask settled asks again', async () => {
    const h = harness({ asks: ['ok', 'ok'], responses: [refused, answered] });
    void h.session.start();
    await h.clock.run();
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      '200',
    );
    expect(asksIn(h.log)).toEqual(['ask:ok', 'ask:ok']);
  });

  test('a refused ask is tried three times, pausing longer each time, then the call fails by name without a second round', async () => {
    const h = harness({
      asks: ['refused', 'refused', 'refused'],
      responses: [refused],
    });
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      'SessionRequiredError',
    );
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
      Promise.all([h.session.fetch('/_serverFn/s-abc'), h.clock.run()]),
    ).rejects.toBeInstanceOf(SessionRequiredError);
  });

  test('off is final: no retries, and the call is not made again', async () => {
    const h = harness({ asks: ['off'], responses: [refused] });
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      'SessionRequiredError',
    );
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
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      '200',
    );
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
      (await settle(moved, moved.session.fetch('/_serverFn/s-abc'))).result,
    ).toBe('200');
    expect(asksIn(moved.log)).toEqual(['ask:ok']);
  });
});

// The browser check holds the session ask until its challenge has run, and a slow device takes far
// longer than most. Only the server's leg is timed tightly, from when the check lets the ask go.
describe('createSession — a slow or stuck browser check', () => {
  test.each([15_000, 45_000])(
    'a check that holds the first ask %i ms still gets the waiting company call its session: one ask, no refusal',
    async (holdMs) => {
      const h = harness({ asks: [{ outcome: 'ok', holdMs }], edge: true });
      expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
        result: '200',
        at: holdMs,
      });
      expect(asksIn(h.log)).toHaveLength(1);
      expect(refusalsIn(h.log)).toEqual([]);
    },
  );

  test('an ask let go just before the hold bound and answered just after it still counts', async () => {
    const h = harness({
      asks: [{ outcome: 'ok', holdMs: 59_000, serverMs: 2000 }],
      edge: true,
    });
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
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
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
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
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: 'SessionRequiredError',
      at: 0,
    });
    expect(asksIn(h.log)).toHaveLength(1);
    expect(h.log.some((l) => l.startsWith('wait:'))).toBe(false);
  });

  test('a failure after the check let the ask go is tried again', async () => {
    const h = harness({ asks: ['failed', 'ok'], edge: true });
    expect((await settle(h, h.session.fetch('/_serverFn/s-abc'))).result).toBe(
      '200',
    );
    expect(asksIn(h.log)).toEqual(['ask:failed', 'ask:ok']);
    expect(h.log).toContain('wait:1000');
  });

  test('a check that never lets the ask go is given up at its bound: the call fails by name, never hangs', async () => {
    const h = harness({
      asks: [{ outcome: 'ok', holdMs: Number.POSITIVE_INFINITY }],
      edge: true,
    });
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: 'SessionRequiredError',
      at: 60_000,
    });
    expect(asksIn(h.log)).toHaveLength(1);
  });
});

// The check holds a company data call until its challenge has run, as it does an ask. Its hold is
// bounded the same way, and a check that cannot run sends the call past itself, for the server to
// decide, rather than leaving the page waiting with nothing sent.
describe('createSession — a company data call the check holds', () => {
  const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;

  test('a call held past the bound goes out past the check, and is answered', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered],
      checked: [{ holdMs: Number.POSITIVE_INFINITY }],
    });
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
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
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: '200',
      at: 61_000,
    });
    expect(h.log.filter((l) => l.startsWith('unchecked'))).toEqual([]);
  });

  test('a call the check fails (its script failed) goes out past it at once, and so does every later one', async () => {
    const h = harness({
      hint: () => fresh,
      responses: [answered, answered],
      checked: [{ failsHeld: true }, {}],
    });
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: '200',
      at: 0,
    });
    // The first call's unspent bound has run the clock on; the later call adds no wait of its own.
    const later = h.clock.now;
    expect(await settle(h, h.session.fetch('/_serverFn/s-def'))).toEqual({
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
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: 'SessionRequiredError',
      at: 0,
    });
    expect(h.log).toContain('unchecked:403');
  });

  test('a call the check fails with an error is that error, not a dead check', async () => {
    const h = harness({ hint: () => fresh, responses: [] });
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: 'Error',
      at: 0,
    });
    expect(h.log.filter((l) => l.startsWith('unchecked'))).toEqual([]);
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
        (await settle(h, h.session.fetch('/_serverFn/s-abc'))).result,
      ).toBe('200');
      expect(h.log.filter((l) => l === 'wait:250')).toHaveLength(polls);
      expect(asksIn(h.log)).toEqual([]);
      expect(h.log[0]).toBe('check');
    },
  );

  test('a frame whose page never holds a session gives up after its wait', async () => {
    const h = harness({ preview: true, responses: [refused] });
    expect(await settle(h, h.session.fetch('/_serverFn/s-abc'))).toEqual({
      result: 'SessionRequiredError',
      at: 70_000,
    });
    expect(h.log.filter((l) => l.startsWith('fetch:'))).toHaveLength(1);
  });
});
