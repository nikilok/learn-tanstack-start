import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { BROWSER_CHECK_PATH } from './browser-check-config';

/** The app's Vercel project config, beside its package.json. */
const vercelConfig = JSON.parse(
  readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'),
) as {
  rewrites?: { source: string; destination: string }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
};

describe("the browser check is served from Vercel's edge", () => {
  test('vercel.json rewrites the challenge, and every call it makes, to Vercel', () => {
    // Only these rewrites send the challenge from the visitor's own connection: the edge
    // rewrites Nitro builds from its route rules never match, and a challenge the function
    // proxies reaches Vercel from the function's address, so every visitor reads automated.
    expect(vercelConfig.rewrites).toContainEqual({
      source: `${BROWSER_CHECK_PATH}/a-4-a/c.js`,
      destination: 'https://api.vercel.com/bot-protection/v1/challenge',
    });
    expect(vercelConfig.rewrites).toContainEqual({
      source: `${BROWSER_CHECK_PATH}/:path*`,
      destination: 'https://api.vercel.com/bot-protection/v1/proxy/:path*',
    });
    expect(vercelConfig.headers).toContainEqual({
      source: `${BROWSER_CHECK_PATH}/:path*`,
      headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
    });
  });

  test('the BotID client loads its challenge from under the same path', () => {
    // The path is fixed inside the package; an upgrade that moved it would leave the rewrites
    // and the middleware answering a path no client asks for.
    const client = readFileSync(
      new URL(import.meta.resolve('botid/client/core')),
      'utf8',
    );
    expect(client).toContain(`${BROWSER_CHECK_PATH}/a-4-a/c.js`);
  });
});
