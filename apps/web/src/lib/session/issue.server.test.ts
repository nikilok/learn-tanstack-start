import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import type { BrowserVerdict } from '../device/browser-check.server';
import { type IssueDeps, sessionResponse } from './issue.server';
import {
  issueSession,
  readSession,
  SESSION_RENEW_SECONDS,
  SESSION_TTL_SECONDS,
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

function headers(cookie?: string, ip: string | null = visitor): Headers {
  const h = new Headers();
  if (ip) h.set('x-real-ip', ip);
  if (cookie) h.set('cookie', `ss-session=${cookie}`);
  return h;
}

async function ask(h: Headers, deps: IssueDeps) {
  const response = await sessionResponse(h, { secret, now, ...deps });
  const body = (await response.json()) as { session: string };
  const cookies = response.headers.getSetCookie();
  const session = cookies
    .find((c) => c.startsWith('ss-session='))
    ?.split(';')[0]
    ?.slice('ss-session='.length);
  return { response, body, cookies, session };
}

describe('sessionResponse', () => {
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

  test('enforced: an automated browser, verified crawlers included, is refused and its cookies cleared', async () => {
    for (const verdict of ['automated', 'verified crawler'] as const) {
      const { body, cookies } = await ask(headers(), {
        mode: 'enforce',
        verdict: checked(verdict).verdict,
      });
      expect(body.session).toBe('refused');
      expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    }
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
      '[session] browser check: automated (not enforced)',
    );
  });

  test('a check that cannot run issues a session all the same', async () => {
    const { body, session } = await ask(headers(), {
      mode: 'enforce',
      verdict: checked('unchecked').verdict,
    });
    expect(body.session).toBe('ok');
    expect(
      await readSession(session, { scope: visitor, secret, now }),
    ).toMatchObject({
      standing: 'person',
    });
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
