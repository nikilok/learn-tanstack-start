// The session cookie's value: signed, and bound to the address it was issued to. Web Crypto only,
// so the edge middleware and the server verify it the same way.

/** How long a session lasts after it is issued. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export { SESSION_RENEW_SECONDS } from './calls';

/** How long a session lasts when the browser check could not run: it is checked again soon. */
export const SESSION_UNCHECKED_TTL_SECONDS = 60 * 60;

/**
 * How a session was issued: `person` when the browser check passed (or could not run), and
 * `unverified` when it named the browser automated while that was only being observed.
 */
export type SessionStanding = 'person' | 'unverified';

const STANDING_CODE: Record<SessionStanding, string> = {
  person: 'p',
  unverified: 'u',
};

// Expiry in epoch seconds, the standing, then a base64url HMAC-SHA256.
const VALUE_RE = /^(\d{10})\.([pu])\.([\w-]{43})$/;

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** The signing key: derived from the secret, so it signs nothing else's tokens. */
function signingKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
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
      return crypto.subtle.importKey(
        'raw',
        derived,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
    })();
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

/** The bytes a session's signature covers: its standing, its expiry and the address scope. */
function message(code: string, expires: string, scope: string) {
  return encoder.encode(`${code}.${expires}.${scope}`);
}

/** Bytes as unpadded base64url, safe in a cookie value. */
function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The bytes an unpadded base64url string holds. */
function fromBase64Url(text: string) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The secret sessions are signed with; undefined when it is not set. */
export function sessionSecret(
  value = process.env.ENGAGE_TOKEN_SECRET,
): string | undefined {
  return value || undefined;
}

/** A session value for one address scope, and its expiry in epoch seconds. */
export async function issueSession(options: {
  scope: string;
  standing: SessionStanding;
  secret: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<{ value: string; expires: number }> {
  const {
    scope,
    standing,
    secret,
    now = Date.now(),
    ttlSeconds = SESSION_TTL_SECONDS,
  } = options;
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const code = STANDING_CODE[standing];
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    message(code, String(expires), scope),
  );
  return {
    value: `${expires}.${code}.${toBase64Url(signature)}`,
    expires,
  };
}

/** What a request's session value says about it. */
export type SessionRead =
  | { status: 'valid'; standing: SessionStanding; expires: number }
  | { status: 'absent' | 'malformed' | 'expired' | 'elsewhere' };

/**
 * Reads a session value for the address scope it is presented from. `elsewhere` is a value that
 * was not issued to this scope — the visitor's address changed, or it was never ours. Never throws.
 */
export async function readSession(
  value: string | undefined,
  options: { scope: string; secret: string; now?: number },
): Promise<SessionRead> {
  if (!value) return { status: 'absent' };
  const match = VALUE_RE.exec(value);
  if (!match) return { status: 'malformed' };
  const [, expires, code, signature] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const { scope, secret, now = Date.now() } = options;
  if (Number(expires) * 1000 <= now) return { status: 'expired' };
  let verified: boolean;
  try {
    verified = await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      fromBase64Url(signature),
      message(code, expires, scope),
    );
  } catch {
    return { status: 'malformed' };
  }
  if (!verified) return { status: 'elsewhere' };
  return {
    status: 'valid',
    standing: code === 'p' ? 'person' : 'unverified',
    expires: Number(expires),
  };
}

/** One cookie's value from a request's Cookie header, or undefined. */
export function cookieValue(
  headers: Headers,
  name: string,
): string | undefined {
  const header = headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
