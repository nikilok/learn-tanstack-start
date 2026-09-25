import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a token stays valid after it is issued. */
export const TOKEN_TTL_SECONDS = 60 * 60;

// Expiry in epoch seconds, then a base64url HMAC-SHA256 — nothing else parses.
const TOKEN_RE = /^(\d{10})\.([\w-]{43})$/;

type TokenOptions = { secret?: string; now?: number };

/** HMAC over the key and expiry. */
function sign(secret: string, key: string, expires: string): string {
  return createHmac('sha256', secret)
    .update(`${key}.${expires}`)
    .digest('base64url');
}

/** A token bound to one device key, valid for TOKEN_TTL_SECONDS; null when ENGAGE_TOKEN_SECRET is unset. */
export function issueToken(
  key: string,
  {
    secret = process.env.ENGAGE_TOKEN_SECRET,
    now = Date.now(),
  }: TokenOptions = {},
): string | null {
  if (!secret) return null;
  const expires = String(Math.floor(now / 1000) + TOKEN_TTL_SECONDS);
  return `${expires}.${sign(secret, key, expires)}`;
}

/** True only for an unexpired token issued for exactly this key; false for anything else, including an unset secret. Never throws. */
export function tokenMatches(
  token: string,
  key: string,
  {
    secret = process.env.ENGAGE_TOKEN_SECRET,
    now = Date.now(),
  }: TokenOptions = {},
): boolean {
  if (!secret) return false;
  const match = TOKEN_RE.exec(token);
  if (!match) return false;
  const [, expires, signature] = match;
  if (Number(expires) * 1000 <= now) return false;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(secret, key, expires));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
