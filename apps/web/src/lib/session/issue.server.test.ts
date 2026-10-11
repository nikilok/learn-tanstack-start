import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import type { BrowserVerdict } from '../device/browser-check.server';
import { type IssueDeps, sessionResponse } from './issue.server';
import { parseRanges } from './ranges';
import {
  issueSession,
  readSession,
  SESSION_RENEW_SECONDS,
  SESSION_TTL_SECONDS,
  SESSION_UNCHECKED_TTL_SECONDS,
} from './token';

const secret = 'test-secret-not-a-real-one';
const now = Date.UTC(2026, 9, 11, 12);
const visitor = '81.2.69.160';

let logged: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

/** A check that answers once with a fixed verdict, counting how often it was asked. */
function checked(verdict: BrowserVerdict | 'unchecked') {
  const asked = { count: 0 };
  return {
    asked,
    verdict: async () => {
      asked.count++;
      return verdict;
    },
  };
}

/** A request's headers from `ip`, holding the session `cookie` if one is given. */
function headers(cookie?: string, ip: string | null = visitor): Headers {
  const h = new Headers();
  if (ip) h.set('x-real-ip', ip);
  if (cookie) h.set('cookie', `ss-session=${cookie}`);
  return h;
}

/** One ask of the session endpoint, enforcing, read back as its answer and cookies. */
async function ask(h: Headers, deps: IssueDeps) {
  const response = await sessionResponse(h, {
    secret,
    now,
    ranges: async () => null,
    enforce: true,
    ...deps,
  });
  const body = (await response.json()) as { session: string };
  const cookies = response.headers.getSetCookie();
  const session = cookies
    .find((c) => c.startsWith('ss-session='))
    ?.split(';')[0]
    ?.slice('ss-session='.length);
  return { response, body, cookies, session };
}

describe('sessionResponse', () => {
  test('a crawler address is answered off: no check is spent, nothing is issued', async () => {
    const check = checked('verified crawler');
    const crawlers = parseRanges(['66.249.64.0/27']);
    const { body, cookies } = await ask(headers(undefined, '66.249.64.10'), {
      mode: 'enforce',
      verdict: check.verdict,
      ranges: async () => crawlers,
    });
    expect(body.session).toBe('off');
    expect(cookies).toHaveLength(0);
    expect(check.asked.count).toBe(0);
  });

  test('a person is issued a session bound to their address, and a hint beside it', async () => {
    const check = checked('person');
    const { response, body, cookies, session } = await ask(headers(), {
      mode: 'enforce',
      verdict: check.verdict,
    });
    expect(body.session).toBe('ok');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(cookies[1]).toStartWith('ss-session-hint=');
    expect(cookies[1]).not.toContain('HttpOnly');
    expect(
      await readSession(session, { scope: visitor, secret, now }),
    ).toMatchObject({
      status: 'valid',
      standing: 'person',
    });
  });

  test('a session held for this address with time to run is confirmed without a check', async () => {
    const held = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      now,
    });
    const check = checked('automated');
    const { body, cookies } = await ask(headers(held.value), {
      mode: 'enforce',
      verdict: check.verdict,
    });
    expect(body.session).toBe('ok');
    expect(cookies).toHaveLength(0);
    expect(check.asked.count).toBe(0);
  });

  test('one near its end, or from another address, is checked and issued again', async () => {
    const ageing = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      now: now - (SESSION_TTL_SECONDS - SESSION_RENEW_SECONDS + 60) * 1000,
    });
    const moved = await issueSession({
      scope: '81.2.69.161',
      standing: 'person',
      secret,
      now,
    });
    for (const value of [ageing.value, moved.value]) {
      const check = checked('person');
      const { body, session } = await ask(headers(value), {
        mode: 'enforce',
        verdict: check.verdict,
      });
      expect(body.session).toBe('ok');
      expect(check.asked.count).toBe(1);
      expect(session).not.toBe(value);
    }
  });

  test('enforced: an automated browser, verified crawlers included, is refused and both cookies cleared', async () => {
    for (const verdict of ['automated', 'verified crawler'] as const) {
      const { body, cookies } = await ask(headers(), {
        mode: 'enforce',
        verdict: checked(verdict).verdict,
      });
      expect(body.session).toBe('refused');
      expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual([
        'ss-session',
        'ss-session-hint',
      ]);
      expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    }
  });

  test('enforced: a refused renewal leaves a session still held to run out', async () => {
    const ageing = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      now: now - (SESSION_TTL_SECONDS - SESSION_RENEW_SECONDS + 60) * 1000,
    });
    const { body, cookies } = await ask(headers(ageing.value), {
      mode: 'enforce',
      verdict: checked('automated').verdict,
    });
    expect(body.session).toBe('ok');
    expect(cookies).toHaveLength(0);
  });

  test('enforced with the check only watched (BROWSER_CHECK_ENFORCE off): an automated browser is issued a session', async () => {
    const { body, session } = await ask(headers(), {
      mode: 'enforce',
      enforce: false,
      verdict: checked('automated').verdict,
    });
    expect(body.session).toBe('ok');
    expect(
      await readSession(session, { scope: visitor, secret, now }),
    ).toMatchObject({ status: 'valid', standing: 'person' });
    expect(String(logged.mock.calls.at(-1)?.[0])).toBe(
      '[session] verdict: automated (not enforced)',
    );
  });

  test('observed: an automated browser is issued an unverified session, and the verdict is said', async () => {
    const { body, session } = await ask(headers(), {
      mode: 'observe',
      verdict: checked('automated').verdict,
    });
    expect(body.session).toBe('ok');
    expect(
      await readSession(session, { scope: visitor, secret, now }),
    ).toMatchObject({
      standing: 'unverified',
    });
    expect(String(logged.mock.calls.at(-1)?.[0])).toBe(
      '[session] verdict: automated (not enforced)',
    );
  });

  test('a check that cannot run issues a short session, checked again soon', async () => {
    const { body, cookies, session } = await ask(headers(), {
      mode: 'enforce',
      verdict: checked('unchecked').verdict,
    });
    expect(body.session).toBe('ok');
    expect(cookies[0]).toContain(`Max-Age=${SESSION_UNCHECKED_TTL_SECONDS}`);
    expect(cookies[1]).toContain(`Max-Age=${SESSION_UNCHECKED_TTL_SECONDS}`);
    const read = await readSession(session, { scope: visitor, secret, now });
    expect(read).toMatchObject({ status: 'valid', standing: 'person' });
    expect(read.status === 'valid' && read.expires).toBe(
      Math.floor(now / 1000) + SESSION_UNCHECKED_TTL_SECONDS,
    );
    expect(
      await readSession(session, {
        scope: visitor,
        secret,
        now: now + (SESSION_UNCHECKED_TTL_SECONDS + 1) * 1000,
      }),
    ).toMatchObject({ status: 'expired' });
  });

  test('off, with no secret, or with no address: nothing is issued and nothing is checked', async () => {
    for (const [h, deps] of [
      [headers(), { mode: null }],
      [headers(), { mode: 'enforce', secret: undefined }],
      [headers(undefined, null), { mode: 'enforce' }],
    ] as const) {
      const check = checked('person');
      const { body, cookies } = await ask(h, {
        ...deps,
        verdict: check.verdict,
      });
      expect(body.session).toBe('off');
      expect(cookies).toHaveLength(0);
      expect(check.asked.count).toBe(0);
    }
  });
});
