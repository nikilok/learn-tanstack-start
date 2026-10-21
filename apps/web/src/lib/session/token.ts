// The session cookie's value: signed, and bound to the address it was issued to and the device it
// was issued to. Web Crypto only, so the edge middleware and the server verify it the same way.

import { DEVICE_KEY_RE } from '../device/key';

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

// A device key as a session value spells it: the shape the pages send (`DEVICE_KEY_RE`), so the two
// cannot drift apart.
const DEVICE_GROUP = DEVICE_KEY_RE.source.replace(/^\^|\$$/g, '');

// Expiry in epoch seconds, the standing, the device key (`-` when there is none), then a base64url
// HMAC-SHA256 over them and the address scope.
const VALUE_RE = new RegExp(
  `^(\\d{10})\\.([pu])\\.(${DEVICE_GROUP}|-)\\.([\\w-]{43})$`,
);

// The shape before sessions named their device: expiry, standing, signature. Still read, as a
// session naming no device, until the last of them runs out, so a deploy takes no session away.
const LEGACY_VALUE_RE = /^(\d{10})\.([pu])\.([\w-]{43})$/;

/** How a session value spells the device it was issued to: its key, or `-` for none. */
const NO_DEVICE = '-';

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

/**
 * The bytes a session's signature covers: its standing, its expiry, the address scope and the
 * device. A value of the earlier shape signed no device (`undefined`).
 */
function message(
  code: string,
  expires: string,
  scope: string,
  device: string | undefined,
) {
  return encoder.encode(
    device === undefined
      ? `${code}.${expires}.${scope}`
      : `${code}.${expires}.${scope}.${device}`,
  );
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

/** A session value for one address scope and device, and its expiry in epoch seconds. */
export async function issueSession(options: {
  scope: string;
  standing: SessionStanding;
  secret: string;
  /** The device key the page sent, or null when it had none. */
  device?: string | null;
  now?: number;
  ttlSeconds?: number;
}): Promise<{ value: string; expires: number }> {
  const {
    scope,
    standing,
    secret,
    device = null,
    now = Date.now(),
    ttlSeconds = SESSION_TTL_SECONDS,
  } = options;
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const code = STANDING_CODE[standing];
  // Only a key the reader takes is named: anything else would sign a value nobody could read.
  const named =
    device !== null && DEVICE_KEY_RE.test(device) ? device : NO_DEVICE;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    message(code, String(expires), scope, named),
  );
  return {
    value: `${expires}.${code}.${named}.${toBase64Url(signature)}`,
    expires,
  };
}

/** What a request's session value says about it. */
export type SessionRead =
  | {
      status: 'valid';
      standing: SessionStanding;
      expires: number;
      /** The device key it was issued to, or null when the page had none. */
      device: string | null;
    }
  | { status: 'absent' | 'malformed' | 'expired' | 'elsewhere' };

/**
 * Reads a session value for the address scope it is presented from. `elsewhere` is a value that
 * was not issued to this scope — the visitor's address changed, or it was never ours. The device it
 * names is covered by the signature, so it cannot be swapped for another; a value of the earlier
 * shape names none. Never throws.
 */
export async function readSession(
  value: string | undefined,
  options: { scope: string; secret: string; now?: number },
): Promise<SessionRead> {
  if (!value) return { status: 'absent' };
  const current = VALUE_RE.exec(value);
  const legacy = current ? null : LEGACY_VALUE_RE.exec(value);
  let expires: string;
  let code: string;
  let device: string | undefined;
  let signature: string;
  if (current)
    [, expires = '', code = '', device = '', signature = ''] = current;
  else if (legacy) [, expires = '', code = '', signature = ''] = legacy;
  else return { status: 'malformed' };
  const { scope, secret, now = Date.now() } = options;
  if (Number(expires) * 1000 <= now) return { status: 'expired' };
  let verified: boolean;
  try {
    verified = await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      fromBase64Url(signature),
      message(code, expires, scope, device),
    );
  } catch {
    return { status: 'malformed' };
  }
  if (!verified) return { status: 'elsewhere' };
  return {
    status: 'valid',
    standing: code === 'p' ? 'person' : 'unverified',
    expires: Number(expires),
    device: device === undefined || device === NO_DEVICE ? null : device,
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
