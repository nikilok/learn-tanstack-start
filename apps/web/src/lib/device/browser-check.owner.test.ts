import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import { encryptFlagValues } from 'flags';

import type { BrowserCheck } from './browser-check.server';

// ownerOrBrowser reads the owner from the current request when no reader is given. Outside a
// request that read throws, so the request is stood in for here: the rest of the module is real.
let cookie: string | undefined;
const server = await import('@tanstack/react-start/server');
mock.module('@tanstack/react-start/server', () => ({
  ...server,
  getRequest: () =>
    new Request('https://example.test/', {
      headers: cookie ? { cookie } : {},
    }),
}));
const { ownerOrBrowser } = await import('./browser-check.server');

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
  'base64url',
);
const saved = process.env.FLAGS_SECRET;
beforeAll(() => {
  process.env.FLAGS_SECRET = SECRET;
});
afterAll(() => {
  if (saved === undefined) delete process.env.FLAGS_SECRET;
  else process.env.FLAGS_SECRET = saved;
});

/** A check that always names the caller automated, counting how often it was asked. */
function automated() {
  const asked = { count: 0 };
  const check = (async () => {
    asked.count++;
    return {
      isHuman: false,
      isBot: true,
      isVerifiedBot: false,
      bypassed: false,
    };
  }) as BrowserCheck;
  return { asked, check };
}

describe('ownerOrBrowser, reading the owner from the request', () => {
  test("the request's own owner cookie skips the check", async () => {
    cookie = `ss-owner=${await encryptFlagValues({ 'ss-owner': true }, SECRET)}`;
    const { asked, check } = automated();
    expect(await ownerOrBrowser('page', { check, enforce: true })).toBe(true);
    expect(asked.count).toBe(0);
  });

  test("a request without one is the check's to answer", async () => {
    cookie = undefined;
    const { asked, check } = automated();
    expect(await ownerOrBrowser('page', { check, enforce: true })).toBe(false);
    expect(asked.count).toBe(1);
  });

  test('a cookie sealed with another key is not the owner', async () => {
    const other = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString('base64url');
    cookie = `ss-owner=${await encryptFlagValues({ 'ss-owner': true }, other)}`;
    const { asked, check } = automated();
    expect(await ownerOrBrowser('page', { check, enforce: true })).toBe(false);
    expect(asked.count).toBe(1);
  });
});
