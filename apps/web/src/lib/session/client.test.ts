import { describe, expect, test } from 'bun:test';

import { createSession, type SessionDeps, type SessionOutcome } from './client';

const refused = () =>
  new Response(null, { status: 403, headers: { 'x-session': 'required' } });
const answered = () => new Response('{}', { status: 200 });

/** A session over scripted asks and responses, recording what it did. */
function harness(options: {
  asks?: SessionOutcome[];
  responses?: Array<() => Response>;
  preview?: boolean;
  hint?: () => number | null;
}) {
  const asks = [...(options.asks ?? [])];
  const responses = [...(options.responses ?? [])];
  const log: string[] = [];
  const deps: SessionDeps = {
    ask: async () => {
      const outcome = asks.shift() ?? 'failed';
      log.push(`ask:${outcome}`);
      return outcome;
    },
    wait: async (ms) => {
      log.push(`wait:${ms}`);
    },
    hintExpiry: options.hint ?? (() => null),
    preview: () => options.preview ?? false,
    now: () => 0,
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

describe('createSession', () => {
  test('a call goes out at once, and starts the session behind it', async () => {
    const { session, log } = harness({ asks: ['ok'], responses: [answered] });
    expect((await session.fetch('/_serverFn/abc')).status).toBe(200);
    expect(log.slice(0, 2)).toEqual(['check', 'ask:ok']);
    expect(log).toContain('fetch');
  });

  test('a call refused for want of a session waits for the first ask, then goes again', async () => {
    const { session, log } = harness({
      asks: ['ok'],
      responses: [refused, answered],
    });
    expect((await session.fetch('/_serverFn/s-abc')).status).toBe(200);
    expect(log.filter((l) => l.startsWith('ask'))).toEqual(['ask:ok']);
    expect(log.filter((l) => l === 'fetch')).toHaveLength(2);
  });

  test('a refusal after the first ask settled asks again', async () => {
    const { session, log } = harness({
      asks: ['ok', 'ok'],
      responses: [refused, answered],
    });
    await session.start();
    expect((await session.fetch('/_serverFn/s-abc')).status).toBe(200);
    expect(log.filter((l) => l.startsWith('ask'))).toEqual([
      'ask:ok',
      'ask:ok',
    ]);
  });

  test('a refused ask is tried three times, pausing longer each time, then the refusal stands', async () => {
    const { session, log } = harness({
      asks: ['refused', 'refused', 'refused'],
      responses: [refused],
    });
    expect((await session.fetch('/_serverFn/s-abc')).status).toBe(403);
    expect(
      log.filter((l) => l.startsWith('ask') || l.startsWith('wait')),
    ).toEqual([
      'ask:refused',
      'wait:1000',
      'ask:refused',
      'wait:2000',
      'ask:refused',
    ]);
  });

  test('off is final: no retries, and the call is not made again', async () => {
    const { session, log } = harness({ asks: ['off'], responses: [refused] });
    expect((await session.fetch('/_serverFn/s-abc')).status).toBe(403);
    expect(log.filter((l) => l.startsWith('ask'))).toEqual(['ask:off']);
    expect(log.filter((l) => l === 'fetch')).toHaveLength(1);
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
    expect(log.filter((l) => l.startsWith('ask'))).toHaveLength(1);
  });

  test('a preview frame never asks: a refusal waits for its page to hold a session', async () => {
    let hint: number | null = null;
    const { session, log } = harness({
      preview: true,
      responses: [refused, answered],
      hint: () => hint,
    });
    const pending = session.fetch('/_serverFn/s-abc');
    hint = 10_000_000_000;
    expect((await pending).status).toBe(200);
    expect(log.some((l) => l.startsWith('ask') || l === 'check')).toBe(false);
  });
});
