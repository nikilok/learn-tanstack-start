import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The visitor session token: an opaque random id, an issue time, and an HMAC over both, signed
// with SESSION_SECRET. It identifies a browser session and nothing else — no account, no
// person-identifying value. Kept pure (no cookie or request access) so every rule here is
// testable without a server; session.server.ts does the IO.

export const SESSION_TOKEN_VERSION = 'v1';

/** How long a token verifies for. The cookie's max-age matches, so the two expire together. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Clock skew a token's issue time may run ahead of the verifying server by before it is refused. */
const FUTURE_TOLERANCE_MS = 60_000;

/** 128 random bits, base64url — 22 characters, no padding. */
export function newSessionId(): string {
  return randomBytes(16).toString('base64url');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** `v1.<id>.<issuedAt>.<signature>` — every part base64url or digits, so it is cookie-safe as is. */
export function mintSessionToken(
  secret: string,
  id: string,
  issuedAt: number,
): string {
  const payload = `${SESSION_TOKEN_VERSION}.${id}.${issuedAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * The session a token names, or null when it does not verify — a tampered or truncated value,
 * a different secret, a version this code does not issue, an issue time in the future, or an
 * age past `maxAgeMs`. Null is the only failure mode: a bad token is simply not a session.
 */
export function verifySessionToken(
  secret: string,
  token: string,
  now: number,
  maxAgeMs = SESSION_MAX_AGE_MS,
): { id: string; issuedAt: number } | null {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_TOKEN_VERSION) return null;
  const [, id, issuedAtRaw, signature] = parts;
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(id) || !/^\d{1,16}$/.test(issuedAtRaw))
    return null;
  const expected = sign(
    secret,
    `${SESSION_TOKEN_VERSION}.${id}.${issuedAtRaw}`,
  );
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
    return null;
  const issuedAt = Number(issuedAtRaw);
  if (issuedAt > now + FUTURE_TOLERANCE_MS) return null;
  if (now - issuedAt > maxAgeMs) return null;
  return { id, issuedAt };
}

/** The UTC hour a moment falls in — the window session_visits counts distinct slugs within. */
export function hourBucket(now: number): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}
