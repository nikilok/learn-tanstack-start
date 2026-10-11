import { describe, expect, test } from 'bun:test';

import {
  cookieValue,
  issueSession,
  readSession,
  SESSION_TTL_SECONDS,
  sessionSecret,
} from './token';

const secret = 'test-secret-not-a-real-one';
const now = Date.UTC(2026, 9, 11, 12);
const scope = '81.2.69.160';

describe('issueSession / readSession', () => {
  test('a session reads back valid, from the address it was issued to', async () => {
    const { value, expires } = await issueSession({
      scope,
      standing: 'person',
      secret,
      now,
    });
    expect(expires).toBe(Math.floor(now / 1000) + SESSION_TTL_SECONDS);
    expect(await readSession(value, { scope, secret, now })).toEqual({
      status: 'valid',
      standing: 'person',
      expires,
    });
  });

  test('presented from another address it is elsewhere', async () => {
    const { value } = await issueSession({
      scope,
      standing: 'person',
      secret,
      now,
    });
    expect(
      (await readSession(value, { scope: '81.2.69.161', secret, now })).status,
    ).toBe('elsewhere');
  });

  test('its standing cannot be changed, nor its expiry pushed out', async () => {
    const { value } = await issueSession({
      scope,
      standing: 'unverified',
      secret,
      now,
    });
    const [expires, , signature] = value.split('.');
    const promoted = `${expires}.p.${signature}`;
    const extended = `${Number(expires) + 86_400}.u.${signature}`;
    for (const forged of [promoted, extended])
      expect((await readSession(forged, { scope, secret, now })).status).toBe(
        'elsewhere',
      );
  });

  test('it expires', async () => {
    const { value } = await issueSession({
      scope,
      standing: 'person',
      secret,
      now,
    });
    const later = now + SESSION_TTL_SECONDS * 1000;
    expect(
      (await readSession(value, { scope, secret, now: later })).status,
    ).toBe('expired');
  });

  test('another secret does not verify it', async () => {
    const { value } = await issueSession({
      scope,
      standing: 'person',
      secret,
      now,
    });
    expect(
      (await readSession(value, { scope, secret: 'another', now })).status,
    ).toBe('elsewhere');
  });

  test('absent and malformed values say so', async () => {
    expect((await readSession(undefined, { scope, secret, now })).status).toBe(
      'absent',
    );
    for (const bad of [
      'x',
      '1234567890.p.short',
      `1234567890.z.${'a'.repeat(43)}`,
    ])
      expect((await readSession(bad, { scope, secret, now })).status).toBe(
        'malformed',
      );
  });
});

describe('cookieValue', () => {
  test('finds one cookie among several', () => {
    const headers = new Headers({
      cookie: 'a=1; ss-session=abc.def; ss-session-hint=123',
    });
    expect(cookieValue(headers, 'ss-session')).toBe('abc.def');
    expect(cookieValue(headers, 'ss-session-hint')).toBe('123');
    expect(cookieValue(headers, 'missing')).toBeUndefined();
    expect(cookieValue(new Headers(), 'ss-session')).toBeUndefined();
  });
});

test('sessionSecret is undefined when unset or empty', () => {
  expect(sessionSecret('')).toBeUndefined();
  expect(sessionSecret('s')).toBe('s');
});
