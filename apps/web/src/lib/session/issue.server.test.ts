import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { encryptFlagValues } from 'flags';

import type { BrowserVerdict } from '../device/browser-check.server';
import { deviceOf, type IssueDeps, sessionResponse } from './issue.server';
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
/** The device the page names, and another. */
const device = 'a'.repeat(32);
const otherDevice = 'b'.repeat(32);

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

/** One ask of the session endpoint, enforcing, naming `named`, read back as its answer and cookies. */
async function ask(h: Headers, deps: IssueDeps, named: string | null = device) {
  const response = await sessionResponse(h, named, {
    secret,
    now,
    ranges: async () => null,
    enforce: true,
    owner: async () => false,
    suspendedKeys: async () => new Set(),
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

  test("the owner's browser is issued a session without asking the check", async () => {
    const check = checked('automated');
    const { body, session } = await ask(headers(), {
      mode: 'enforce',
      verdict: check.verdict,
      owner: async () => true,
    });
    expect(body.session).toBe('ok');
    expect(check.asked.count).toBe(0);
    expect(await readSession(session, { scope: visitor, secret, now })).toEqual(
      {
        status: 'valid',
        standing: 'person',
        expires: now / 1000 + SESSION_TTL_SECONDS,
        device,
      },
    );
    expect(String(logged.mock.calls[0]?.[0])).toBe('[session] owner');
  });

  test("the owner's browser is issued one even with its device suspended", async () => {
    const { body } = await ask(headers(), {
      mode: 'enforce',
      owner: async () => true,
      suspendedKeys: async () => new Set([device]),
    });
    expect(body.session).toBe('ok');
  });

  test("by default the owner is read from the request's own cookies", async () => {
    const flagsSecret = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString('base64url');
    const saved = process.env.FLAGS_SECRET;
    process.env.FLAGS_SECRET = flagsSecret;
    try {
      const owner = await encryptFlagValues({ 'ss-owner': true }, flagsSecret);
      const request = (cookie?: string) => {
        const h = headers();
        if (cookie) h.set('cookie', `ss-owner=${cookie}`);
        return h;
      };
      for (const [cookie, answered, asked] of [
        [owner, 'ok', 0],
        [undefined, 'refused', 1],
      ] as const) {
        const check = checked('automated');
        const response = await sessionResponse(request(cookie), device, {
          secret,
          now,
          ranges: async () => null,
          enforce: true,
          mode: 'enforce',
          verdict: check.verdict,
          suspendedKeys: async () => new Set(),
        });
        const body = (await response.json()) as { session: string };
        expect(body.session).toBe(answered);
        expect(check.asked.count).toBe(asked);
      }
    } finally {
      if (saved === undefined) delete process.env.FLAGS_SECRET;
      else process.env.FLAGS_SECRET = saved;
    }
  });

  test('a person is issued a session bound to their address and device, and a hint beside it', async () => {
    const check = checked('person');
    const { response, body, cookies, session } = await ask(headers(), {
      mode: 'enforce',
      verdict: check.verdict,
    });
    expect(body.session).toBe('ok');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(cookies[1]).toStartWith('ss-session-expiry=');
    expect(cookies[1]).not.toContain('HttpOnly');
    // The hint's earlier name is cleared, so no browser keeps both.
    expect(cookies[2]).toStartWith('ss-session-hint=;');
    expect(cookies[2]).toContain('Max-Age=0');
    expect(
      await readSession(session, { scope: visitor, secret, now }),
    ).toMatchObject({
      status: 'valid',
      standing: 'person',
      device,
    });
  });

  test('a page that names no device is issued a short session, naming none, checked again soon', async () => {
    const { body, cookies, session } = await ask(
      headers(),
      { mode: 'enforce', verdict: checked('person').verdict },
      null,
    );
    expect(body.session).toBe('ok');
    expect(cookies[0]).toContain(`Max-Age=${SESSION_UNCHECKED_TTL_SECONDS}`);
    expect(
      await readSession(session, { scope: visitor, secret, now }),
    ).toMatchObject({ status: 'valid', device: null });
    expect(String(logged.mock.calls.at(-1)?.[0])).toBe(
      '[session] no device: short session',
    );
  });

  test('a session held for this address and device with time to run is confirmed without a check', async () => {
    const held = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      device,
      now,
    });
    // Asked by the same device, and by a page whose key did not arrive in time.
    for (const named of [device, null]) {
      const check = checked('automated');
      const { body, cookies } = await ask(
        headers(held.value),
        { mode: 'enforce', verdict: check.verdict },
        named,
      );
      expect(body.session).toBe('ok');
      expect(cookies).toHaveLength(0);
      expect(check.asked.count).toBe(0);
    }
  });

  test('a short session naming no device is kept while the page still names none, and bound once it names one', async () => {
    const held = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      now,
      ttlSeconds: SESSION_UNCHECKED_TTL_SECONDS,
    });
    const quiet = checked('person');
    const kept = await ask(
      headers(held.value),
      { mode: 'enforce', verdict: quiet.verdict },
      null,
    );
    expect(kept.body.session).toBe('ok');
    expect(kept.cookies).toHaveLength(0);
    expect(quiet.asked.count).toBe(0);
    const named = checked('person');
    const bound = await ask(headers(held.value), {
      mode: 'enforce',
      verdict: named.verdict,
    });
    expect(named.asked.count).toBe(1);
    expect(bound.cookies[0]).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(
      await readSession(bound.session, { scope: visitor, secret, now }),
    ).toMatchObject({ status: 'valid', device });
  });

  test("a renewal whose key did not arrive keeps the held session's device, and its full lifetime", async () => {
    const ageing = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      device,
      now: now - (SESSION_TTL_SECONDS - SESSION_RENEW_SECONDS + 60) * 1000,
    });
    const { body, cookies, session } = await ask(
      headers(ageing.value),
      { mode: 'enforce', verdict: checked('person').verdict },
      null,
    );
    expect(body.session).toBe('ok');
    expect(cookies[0]).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(
      await readSession(session, { scope: visitor, secret, now }),
    ).toMatchObject({ status: 'valid', device });
  });

  test('a session held for another device, or for none, is checked and issued again for the one the page names', async () => {
    for (const heldFor of [otherDevice, null]) {
      const held = await issueSession({
        scope: visitor,
        standing: 'person',
        secret,
        device: heldFor,
        now,
      });
      const check = checked('person');
      const { body, session } = await ask(headers(held.value), {
        mode: 'enforce',
        verdict: check.verdict,
      });
      expect(body.session).toBe('ok');
      expect(check.asked.count).toBe(1);
      expect(
        await readSession(session, { scope: visitor, secret, now }),
      ).toMatchObject({ status: 'valid', device });
    }
  });

  test('enforced: a suspended device is refused, whether it asks with its key or holds a session issued to it, and every session cookie is cleared', async () => {
    const heldElsewhere = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      device: otherDevice,
      now,
    });
    // Its own session, with time to run: refused all the same, ahead of being kept.
    const heldOwn = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      device,
      now,
    });
    for (const [h, suspendedKey] of [
      [headers(), device],
      [headers(heldElsewhere.value), otherDevice],
      [headers(heldOwn.value), device],
    ] as const) {
      const check = checked('person');
      const { body, cookies } = await ask(h, {
        mode: 'enforce',
        verdict: check.verdict,
        suspendedKeys: async () => new Set([suspendedKey]),
      });
      expect(body.session).toBe('refused');
      expect(check.asked.count).toBe(0);
      expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual([
        'ss-session',
        'ss-session-expiry',
        'ss-session-hint',
      ]);
      expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    }
    expect(String(logged.mock.calls.at(-1)?.[0])).toBe(
      '[session] suspended device: refused',
    );
  });

  test('observed: a suspended device is only said, and issued a session', async () => {
    const { body } = await ask(headers(), {
      mode: 'observe',
      verdict: checked('person').verdict,
      suspendedKeys: async () => new Set([device]),
    });
    expect(body.session).toBe('ok');
    expect(String(logged.mock.calls[0]?.[0])).toBe(
      '[session] suspended device (not enforced)',
    );
  });

  test('one near its end, or from another address, is checked and issued again', async () => {
    const ageing = await issueSession({
      scope: visitor,
      standing: 'person',
      secret,
      device,
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
        'ss-session-expiry',
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

describe('deviceOf', () => {
  test("names the body's key when it is well-formed, and nothing otherwise", () => {
    expect(deviceOf({ key: device })).toBe(device);
    for (const body of [
      null,
      undefined,
      'a',
      {},
      { key: 42 },
      { key: device.toUpperCase() },
      { key: `${device}0` },
      { key: '../x' },
    ])
      expect(deviceOf(body)).toBeNull();
  });
});
