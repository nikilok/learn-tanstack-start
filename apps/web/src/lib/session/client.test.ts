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

/** A session over scripted asks and responses, recording what it did. */
function harness(options: {
  asks?: SessionOutcome[];
  responses?: Array<() => Response>;
  preview?: boolean;
  hint?: () => number | null;
  /** Called on every wait, before it resolves. */
  onWait?: (ms: number) => void;
  /** Asks never answer, and the ask deadline passes. */
  stall?: boolean;
  /** Each ask answers only once this settles, logged as `answer:<outcome>`. */
  gate?: Promise<void>;
}) {
  const asks = [...(options.asks ?? [])];
  const responses = [...(options.responses ?? [])];
  const log: string[] = [];
  const deps: SessionDeps = {
    ask: async () => {
      if (options.stall) {
        log.push('ask:stalled');
        return new Promise<SessionOutcome>(() => {});
      }
      const outcome = asks.shift() ?? 'failed';
      log.push(`ask:${outcome}`);
      if (options.gate) {
        await options.gate;
        log.push(`answer:${outcome}`);
      }
      return outcome;
    },
    wait: async (ms) => {
      log.push(`wait:${ms}`);
      options.onWait?.(ms);
    },
    timeout: (ms) =>
      options.stall
        ? Promise.resolve().then(() => void log.push(`timeout:${ms}`))
        : new Promise<void>(() => {}),
    hintExpiry: options.hint ?? (() => null),
    preview: () => options.preview ?? false,
    now: () => NOW,
    fetch: async () => {
      const next = responses.shift();
      if (!next) throw new Error('no response scripted');
      log.push('fetch');
      return next();
    },
    startCheck: () => log.push('check'),
  };
  return { session: createSession(deps), log };
}

/** The asks a session made, in order. */
const asksIn = (log: string[]) => log.filter((l) => l.startsWith('ask'));

/** A promise and the function that settles it. */
function deferred() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSession', () => {
  test('a call goes out at once, and starts the session behind it', async () => {
    const { session, log } = harness({ asks: ['ok'], responses: [answered] });
    expect((await session.fetch('/_serverFn/abc')).status).toBe(200);
    expect(log.slice(0, 2)).toEqual(['check', 'ask:ok']);
    expect(log).toContain('fetch');
  });

  test('a company data call made with no session waits for the first ask, and goes once', async () => {
    const gate = deferred();
    const { session, log } = harness({
      asks: ['ok'],
      responses: [answered],
      gate: gate.promise,
    });
    const call = session.fetch('/_serverFn/s-abc');
    await settle();
    expect(log).not.toContain('fetch');
    gate.open();
    expect((await call).status).toBe(200);
    expect(log).toEqual(['check', 'ask:ok', 'answer:ok', 'fetch']);
  });

  test('a company data call given as a URL waits too', async () => {
    const gate = deferred();
    const { session, log } = harness({
      asks: ['ok'],
      responses: [answered],
      gate: gate.promise,
    });
    const call = session.fetch(new URL('https://example.test/_serverFn/s-abc'));
    await settle();
    expect(log).not.toContain('fetch');
    gate.open();
    expect((await call).status).toBe(200);
  });

  test('any other call goes out while the first ask is still out', async () => {
    const gate = deferred();
    const { session, log } = harness({
      asks: ['ok'],
      responses: [answered],
      gate: gate.promise,
    });
    const call = session.fetch('/_serverFn/abc');
    await settle();
    expect(log).toContain('fetch');
    gate.open();
    expect((await call).status).toBe(200);
  });

  test('with a session that has not run out, a company data call does not wait for its renewal', async () => {
    const gate = deferred();
    const ending = NOW / 1000 + SESSION_RENEW_SECONDS - 3600;
    const { session, log } = harness({
      asks: ['ok'],
      responses: [answered],
      hint: () => ending,
      gate: gate.promise,
    });
    const call = session.fetch('/_serverFn/s-abc');
    await settle();
    expect(log).toEqual(['check', 'ask:ok', 'fetch']);
    gate.open();
    expect((await call).status).toBe(200);
  });

  test('a call refused after the first ask got a session renews once, then goes again', async () => {
    const { session, log } = harness({
      asks: ['ok', 'ok'],
      responses: [refused, answered],
    });
    expect((await session.fetch('/_serverFn/s-abc')).status).toBe(200);
    expect(asksIn(log)).toEqual(['ask:ok', 'ask:ok']);
    expect(log.filter((l) => l === 'fetch')).toHaveLength(2);
  });

  test('a refusal after the first ask settled asks again', async () => {
    const { session, log } = harness({
      asks: ['ok', 'ok'],
      responses: [refused, answered],
    });
    await session.start();
    expect((await session.fetch('/_serverFn/s-abc')).status).toBe(200);
    expect(asksIn(log)).toEqual(['ask:ok', 'ask:ok']);
  });

  test('a refused ask is tried three times, pausing longer each time, then the call fails by name without a second round', async () => {
    const { session, log } = harness({
      asks: ['refused', 'refused', 'refused'],
      responses: [refused],
    });
    await expect(session.fetch('/_serverFn/s-abc')).rejects.toBeInstanceOf(
      SessionRequiredError,
    );
    expect(
      log.filter((l) => l.startsWith('ask') || l.startsWith('wait')),
    ).toEqual([
      'ask:refused',
      'wait:1000',
      'ask:refused',
      'wait:2000',
      'ask:refused',
    ]);
    expect(log.filter((l) => l === 'fetch')).toHaveLength(1);
  });

  test('a call refused again after renewing fails by name, not with the bare response', async () => {
    const { session } = harness({
      asks: ['ok', 'ok'],
      responses: [refused, refused],
    });
    await expect(session.fetch('/_serverFn/s-abc')).rejects.toThrow(
      'Session required',
    );
  });

  test('off is final: no retries, and the call is not made again', async () => {
    const { session, log } = harness({ asks: ['off'], responses: [refused] });
    await expect(session.fetch('/_serverFn/s-abc')).rejects.toBeInstanceOf(
      SessionRequiredError,
    );
    expect(asksIn(log)).toEqual(['ask:off']);
    expect(log.filter((l) => l === 'fetch')).toHaveLength(1);
  });

  test('an ask that stalls ends the asking at its deadline: a refused call fails, never hangs', async () => {
    const { session, log } = harness({ stall: true, responses: [refused] });
    await expect(session.fetch('/_serverFn/s-abc')).rejects.toBeInstanceOf(
      SessionRequiredError,
    );
    expect(asksIn(log)).toEqual(['ask:stalled']);
    expect(log).toContain('timeout:8000');
    expect(log.some((l) => l.startsWith('wait'))).toBe(false);
  });

  test('a response that is not a session refusal is returned as it came', async () => {
    const forbidden = () => new Response(null, { status: 403 });
    const { session, log } = harness({ asks: ['ok'], responses: [forbidden] });
    expect((await session.fetch('/_serverFn/abc')).status).toBe(403);
    expect(log.filter((l) => l === 'fetch')).toHaveLength(1);
  });

  test('the first ask is made once, however many calls start it', async () => {
    const { session, log } = harness({
      asks: ['ok'],
      responses: [answered, answered],
    });
    await Promise.all([
      session.fetch('/a'),
      session.fetch('/b'),
      session.start(),
    ]);
    expect(log.filter((l) => l === 'check')).toHaveLength(1);
    expect(asksIn(log)).toHaveLength(1);
  });

  test('a held session with time to run is not asked for on load', async () => {
    const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;
    const { session, log } = harness({
      responses: [answered],
      hint: () => fresh,
    });
    await session.start();
    expect((await session.fetch('/_serverFn/abc')).status).toBe(200);
    expect(asksIn(log)).toEqual([]);
    expect(log).not.toContain('check');
  });

  test('a held session near its end is asked for on load, and a refused call still renews', async () => {
    const ending = NOW / 1000 + SESSION_RENEW_SECONDS - 3600;
    const fresh = NOW / 1000 + SESSION_RENEW_SECONDS + 3600;
    const near = harness({ asks: ['ok'], hint: () => ending });
    await near.session.start();
    expect(asksIn(near.log)).toEqual(['ask:ok']);
    const moved = harness({
      asks: ['ok'],
      responses: [refused, answered],
      hint: () => fresh,
    });
    expect((await moved.session.fetch('/_serverFn/s-abc')).status).toBe(200);
    expect(asksIn(moved.log)).toEqual(['ask:ok']);
  });

  test('a preview frame never asks: a refusal waits, polling, for its page to hold a session', async () => {
    let hint: number | null = null;
    let polls = 0;
    const { session, log } = harness({
      preview: true,
      responses: [refused, answered],
      hint: () => hint,
      onWait: (ms) => {
        if (ms === 250 && ++polls === 2) hint = NOW / 1000 + 86_400;
      },
    });
    expect((await session.fetch('/_serverFn/s-abc')).status).toBe(200);
    expect(log.filter((l) => l === 'wait:250')).toHaveLength(2);
    expect(log.some((l) => l.startsWith('ask') || l === 'check')).toBe(false);
  });

  test('a preview frame whose page never holds a session gives up after its wait', async () => {
    const { session, log } = harness({
      preview: true,
      responses: [refused],
    });
    await expect(session.fetch('/_serverFn/s-abc')).rejects.toBeInstanceOf(
      SessionRequiredError,
    );
    expect(log.filter((l) => l === 'wait:250')).toHaveLength(12);
    expect(log.filter((l) => l === 'fetch')).toHaveLength(1);
  });
});
