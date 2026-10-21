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
const device = 'a'.repeat(32);

/** A value of the shape sessions had before they named their device, signed as that release signed it. */
async function legacyValue(code: 'p' | 'u', expires: number, at: string) {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const derived = await crypto.subtle.sign(
    'HMAC',
    base,
    encoder.encode('session-cookie'),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    derived,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${code}.${expires}.${at}`),
    ),
  );
  const base64url = btoa(String.fromCharCode(...signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${expires}.${code}.${base64url}`;
}

describe('issueSession / readSession', () => {
  test('a session reads back valid, from the address it was issued to, naming no device when given none', async () => {
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
      device: null,
    });
  });

  test('a session names the device it was issued to', async () => {
    const { value, expires } = await issueSession({
      scope,
      standing: 'person',
      secret,
      device,
      now,
    });
    expect(value.split('.')[2]).toBe(device);
    expect(await readSession(value, { scope, secret, now })).toEqual({
      status: 'valid',
      standing: 'person',
      expires,
      device,
    });
  });

  test('its device cannot be swapped for another, nor taken off', async () => {
    const { value } = await issueSession({
      scope,
      standing: 'person',
      secret,
      device,
      now,
    });
    const [expires, code, , signature] = value.split('.');
    for (const swapped of [
      `${expires}.${code}.${'b'.repeat(32)}.${signature}`,
      `${expires}.${code}.-.${signature}`,
    ])
      expect((await readSession(swapped, { scope, secret, now })).status).toBe(
        'elsewhere',
      );
  });

  test('a value of the shape before sessions named their device still reads, naming none, until it runs out', async () => {
    const expires = Math.floor(now / 1000) + 3600;
    const value = await legacyValue('p', expires, scope);
    expect(await readSession(value, { scope, secret, now })).toEqual({
      status: 'valid',
      standing: 'person',
      expires,
      device: null,
    });
    // Its signature covers its own fields only: it cannot be read for another address, nor turned
    // into a value of the new shape naming a device.
    expect(
      (await readSession(value, { scope: '81.2.69.161', secret, now })).status,
    ).toBe('elsewhere');
    const [e, code, signature] = value.split('.');
    expect(
      (
        await readSession(`${e}.${code}.${device}.${signature}`, {
          scope,
          secret,
          now,
        })
      ).status,
    ).toBe('elsewhere');
    expect(
      (
        await readSession(value, {
          scope,
          secret,
          now: now + 3601 * 1000,
        })
      ).status,
    ).toBe('expired');
  });

  test('a device the reader would not take is not signed into a value', async () => {
    const { value } = await issueSession({
      scope,
      standing: 'person',
      secret,
      device: 'not-a-key',
      now,
    });
    expect(value.split('.')[2]).toBe('-');
    expect(await readSession(value, { scope, secret, now })).toMatchObject({
      status: 'valid',
      device: null,
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
    const [expires, , named, signature] = value.split('.');
    const promoted = `${expires}.p.${named}.${signature}`;
    const extended = `${Number(expires) + 86_400}.u.${named}.${signature}`;
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
      '1234567890.p.-.short',
      `1234567890.z.-.${'a'.repeat(43)}`,
      `1234567890.p.not-a-key.${'a'.repeat(43)}`,
    ])
      expect((await readSession(bad, { scope, secret, now })).status).toBe(
        'malformed',
      );
  });
});

describe('cookieValue', () => {
  test('finds one cookie among several', () => {
    const headers = new Headers({
      cookie: 'a=1; ss-session=abc.def; ss-session-expiry=123',
    });
    expect(cookieValue(headers, 'ss-session')).toBe('abc.def');
    expect(cookieValue(headers, 'ss-session-expiry')).toBe('123');
    expect(cookieValue(headers, 'missing')).toBeUndefined();
    expect(cookieValue(new Headers(), 'ss-session')).toBeUndefined();
  });
});

test('sessionSecret is undefined when unset or empty', () => {
  expect(sessionSecret('')).toBeUndefined();
  expect(sessionSecret('s')).toBe('s');
});
