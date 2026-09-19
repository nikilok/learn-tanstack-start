import { describe, expect, test } from 'bun:test';

import {
  hourBucket,
  mintSessionToken,
  newSessionId,
  SESSION_MAX_AGE_MS,
  SESSION_TOKEN_VERSION,
  verifySessionToken,
} from './token.server';

const SECRET = 'test-secret-do-not-use';
const NOW = Date.UTC(2026, 8, 16, 15, 42, 7);

describe('session token', () => {
  test('a minted token verifies back to its id and issue time', () => {
    const id = newSessionId();
    const token = mintSessionToken(SECRET, id, NOW);
    expect(token.startsWith(`${SESSION_TOKEN_VERSION}.`)).toBe(true);
    expect(verifySessionToken(SECRET, token, NOW + 1000)).toEqual({
      id,
      issuedAt: NOW,
    });
  });

  test('ids are 22 base64url characters and do not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test('the wrong secret does not verify', () => {
    const token = mintSessionToken(SECRET, newSessionId(), NOW);
    expect(verifySessionToken('another-secret', token, NOW)).toBeNull();
  });

  test('a tampered id, time or signature does not verify', () => {
    const token = mintSessionToken(SECRET, newSessionId(), NOW);
    const [v, id, at, sig] = token.split('.');
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    expect(
      verifySessionToken(SECRET, [v, flip(id), at, sig].join('.'), NOW),
    ).toBeNull();
    expect(
      verifySessionToken(SECRET, [v, id, `${at}1`, sig].join('.'), NOW),
    ).toBeNull();
    expect(
      verifySessionToken(SECRET, [v, id, at, flip(sig)].join('.'), NOW),
    ).toBeNull();
    // A truncated signature must not pass a length-mismatched compare either.
    expect(
      verifySessionToken(SECRET, [v, id, at, sig.slice(0, 10)].join('.'), NOW),
    ).toBeNull();
  });

  test('malformed values are not sessions — never a throw', () => {
    for (const bad of [
      '',
      'v1',
      'v1.a.b',
      'v0.x.1.y',
      'v1..1.sig',
      'v1.id.notatime.sig',
    ]) {
      expect(verifySessionToken(SECRET, bad, NOW)).toBeNull();
    }
    expect(
      verifySessionToken(
        '',
        mintSessionToken(SECRET, newSessionId(), NOW),
        NOW,
      ),
    ).toBeNull();
    expect(
      verifySessionToken(SECRET, undefined as unknown as string, NOW),
    ).toBeNull();
  });

  test('a token expires after the max age, and a future-dated one is refused', () => {
    const token = mintSessionToken(SECRET, newSessionId(), NOW);
    expect(
      verifySessionToken(SECRET, token, NOW + SESSION_MAX_AGE_MS),
    ).not.toBeNull();
    expect(
      verifySessionToken(SECRET, token, NOW + SESSION_MAX_AGE_MS + 1),
    ).toBeNull();
    // Issued two minutes "after" now — a clock the server does not share.
    expect(verifySessionToken(SECRET, token, NOW - 120_000)).toBeNull();
    // Within a minute of skew is fine.
    expect(verifySessionToken(SECRET, token, NOW - 30_000)).not.toBeNull();
  });
});

describe('hourBucket', () => {
  test('floors to the UTC hour', () => {
    expect(hourBucket(NOW).toISOString()).toBe('2026-09-16T15:00:00.000Z');
    expect(hourBucket(Date.UTC(2026, 8, 16, 15, 0, 0)).toISOString()).toBe(
      '2026-09-16T15:00:00.000Z',
    );
    expect(
      hourBucket(Date.UTC(2026, 8, 16, 15, 59, 59, 999)).toISOString(),
    ).toBe('2026-09-16T15:00:00.000Z');
  });
});
