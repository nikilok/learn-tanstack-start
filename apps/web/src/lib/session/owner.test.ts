import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { encryptFlagValues, encryptOverrides } from 'flags';

import {
  FLAG_OVERRIDES_COOKIE,
  OWNER_CLAIM,
  OWNER_COOKIE,
  ownerRequest,
} from './owner';

/** A 32-byte key, base64url, as FLAGS_SECRET holds one. */
function secret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    'base64url',
  );
}

const SECRET = secret();

/** A request's headers holding `cookies`. */
function request(cookies: Record<string, string>): Headers {
  return new Headers({
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
  });
}

/** The durable owner cookie, sealed as `owner.server.ts` seals it. */
const ownerCookie = (key = SECRET, claim: unknown = true, expires = '365d') =>
  encryptFlagValues({ [OWNER_CLAIM]: claim } as never, key, expires);

/** Any claims sealed as the flags package seals them (direct key, A256GCM), for shapes it never mints. */
async function seal(claims: object, key = SECRET): Promise<string> {
  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  const header = text(
    new TextEncoder().encode(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey(
    'raw',
    Buffer.from(key, 'base64url'),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(header) },
      aes,
      new TextEncoder().encode(JSON.stringify(claims)),
    ),
  );
  return `${header}..${text(iv)}.${text(sealed.slice(0, -16))}.${text(sealed.slice(-16))}`;
}

/** An hour from now, in epoch seconds. */
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

describe('ownerRequest', () => {
  test('the durable owner cookie, sealed by the flags package, is the owner', async () => {
    expect(
      await ownerRequest(
        request({ [OWNER_COOKIE]: await ownerCookie() }),
        SECRET,
      ),
    ).toBe(true);
  });

  test("the toolbar's override cookie is the owner too", async () => {
    const overrides = await encryptOverrides(
      { 'owner-bootstrap': true },
      SECRET,
    );
    expect(
      await ownerRequest(
        request({ [FLAG_OVERRIDES_COOKIE]: overrides }),
        SECRET,
      ),
    ).toBe(true);
  });

  test('a cookie sealed with another key, or tampered with, is no one', async () => {
    const other = await ownerCookie(secret());
    const genuine = await ownerCookie();
    const parts = genuine.split('.');
    parts[3] = `${parts[3]?.slice(0, -2)}AA`;
    for (const value of [other, parts.join('.'), 'not-a-token', ''])
      expect(
        await ownerRequest(request({ [OWNER_COOKIE]: value }), SECRET),
      ).toBe(false);
  });

  test('an expired cookie is no one', async () => {
    const value = await ownerCookie(SECRET, true, '1h');
    expect(
      await ownerRequest(
        request({ [OWNER_COOKIE]: value }),
        SECRET,
        Date.now() + 2 * 60 * 60 * 1000,
      ),
    ).toBe(false);
  });

  test('the owner claim counts only when sealed for the purpose of flag values', async () => {
    const claims = { v: { [OWNER_CLAIM]: true }, exp: inAnHour() };
    const owner = (pur: unknown) =>
      seal({ ...claims, pur }).then((value) =>
        ownerRequest(request({ [OWNER_COOKIE]: value }), SECRET),
      );
    expect(await owner('values')).toBe(true);
    expect(await owner(['definitions', 'values'])).toBe(true);
    expect(await owner('overrides')).toBe(false);
    expect(await owner(undefined)).toBe(false);
  });

  test('a cookie sealed for another purpose, or without the owner claim, is no one', async () => {
    const overrides = await encryptOverrides({ [OWNER_CLAIM]: true }, SECRET);
    expect(
      await ownerRequest(request({ [OWNER_COOKIE]: overrides }), SECRET),
    ).toBe(false);
    expect(
      await ownerRequest(
        request({ [OWNER_COOKIE]: await ownerCookie(SECRET, false) }),
        SECRET,
      ),
    ).toBe(false);
    const values = await ownerCookie();
    expect(
      await ownerRequest(request({ [FLAG_OVERRIDES_COOKIE]: values }), SECRET),
    ).toBe(false);
  });

  test('without a secret, or a usable one, no one is the owner', async () => {
    const headers = request({ [OWNER_COOKIE]: await ownerCookie() });
    expect(await ownerRequest(headers, undefined)).toBe(false);
    expect(await ownerRequest(headers, '')).toBe(false);
    expect(await ownerRequest(headers, 'short')).toBe(false);
    expect(await ownerRequest(new Headers(), SECRET)).toBe(false);
  });

  test('the names match the ones owner.server.ts and flags.server.ts mint and read', () => {
    const src = (file: string) =>
      readFileSync(join(import.meta.dir, '../..', file), 'utf8');
    expect(src('owner.server.ts')).toContain(
      `const OWNER_COOKIE = '${OWNER_COOKIE}';`,
    );
    expect(src('owner.server.ts')).toContain(
      `const OWNER_CLAIM = '${OWNER_CLAIM}';`,
    );
    expect(src('flags.server.ts')).toContain(
      `export const FLAG_OVERRIDES_COOKIE = '${FLAG_OVERRIDES_COOKIE}';`,
    );
  });
});
