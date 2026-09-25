import { describe, expect, test } from 'bun:test';

import { issueToken, TOKEN_TTL_SECONDS, tokenMatches } from './token.server';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const OTHER_KEY = 'f'.repeat(32);
// Synthetic secrets: the tests never read the environment.
const SECRET = 'test-secret-0000000000000000000000000000000000000000';
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const opts = { secret: SECRET, now: NOW };

/** A token issued at NOW for KEY. */
function issued(): string {
  const token = issueToken(KEY, opts);
  if (token === null) throw new Error('expected a token');
  return token;
}

describe('issueToken', () => {
  test('issues a token that matches its own key', () => {
    expect(tokenMatches(issued(), KEY, opts)).toBe(true);
  });

  test('issues nothing without a secret', () => {
    expect(issueToken(KEY, { secret: '', now: NOW })).toBeNull();
  });
});

describe('tokenMatches', () => {
  test('refuses a token presented with another key', () => {
    expect(tokenMatches(issued(), OTHER_KEY, opts)).toBe(false);
  });

  test('refuses a token checked against another secret, or no secret', () => {
    const token = issued();
    expect(tokenMatches(token, KEY, { secret: `${SECRET}x`, now: NOW })).toBe(
      false,
    );
    expect(tokenMatches(token, KEY, { secret: '', now: NOW })).toBe(false);
  });

  test('holds for the TTL and not a second longer', () => {
    const token = issued();
    const expiry = NOW + TOKEN_TTL_SECONDS * 1000;
    expect(tokenMatches(token, KEY, { secret: SECRET, now: expiry - 1 })).toBe(
      true,
    );
    expect(tokenMatches(token, KEY, { secret: SECRET, now: expiry })).toBe(
      false,
    );
  });

  test('refuses a token whose expiry was moved', () => {
    const [expires, signature] = issued().split('.');
    const later = String(Number(expires) + 3600);
    expect(tokenMatches(`${later}.${signature}`, KEY, opts)).toBe(false);
  });

  test('refuses a token whose signature was altered', () => {
    const token = issued();
    const at = 20;
    const flipped = token[at] === 'A' ? 'B' : 'A';
    const altered = `${token.slice(0, at)}${flipped}${token.slice(at + 1)}`;
    expect(tokenMatches(altered, KEY, opts)).toBe(false);
  });

  test('refuses anything not shaped like a token', () => {
    const token = issued();
    for (const bad of [
      '',
      'abc',
      token.replace('.', ''),
      `0${token}`,
      `${token}=`,
      `${token} `,
    ]) {
      expect(tokenMatches(bad, KEY, opts)).toBe(false);
    }
  });
});
