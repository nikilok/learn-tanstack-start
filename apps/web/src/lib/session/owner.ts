// The owner's credential, read from a request's own cookies with Web Crypto alone, so the edge
// middleware and the server read it alike. `src/owner.server.ts` and the Vercel toolbar seal the
// cookies through the `flags` package: compact JWE, a direct key and A256GCM, keyed by
// FLAGS_SECRET, whose rotation revokes them all (CLAUDE.md "/download owner gating").

import { cookieValue } from './token';

/** The durable owner cookie and the claim it carries, as `src/owner.server.ts` mints them. */
export const OWNER_COOKIE = 'ss-owner';
export const OWNER_CLAIM = 'ss-owner';

/** The Vercel toolbar's sealed override cookie: a team member's, which `owner.server.ts` upgrades to the durable one. */
export const FLAG_OVERRIDES_COOKIE = 'vercel-flag-overrides';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey | null>>();

/** The bytes an unpadded base64url string holds, or null when it is not one. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[\w-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The AES-GCM key a secret names (32 bytes, base64url), or null when it names none. */
function keyFor(secret: string): Promise<CryptoKey | null> {
  let key = keys.get(secret);
  if (!key) {
    const raw = fromBase64Url(secret);
    key =
      raw?.length === 32
        ? crypto.subtle
            .importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
            .catch(() => null)
        : Promise.resolve(null);
    keys.set(secret, key);
  }
  return key;
}

/** The claims a cookie was sealed with for `purpose`, or null: not sealed with this key, sealed for another purpose, or expired. */
async function opened(
  value: string,
  purpose: string,
  secret: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  const parts = value.split('.');
  if (parts.length !== 5) return null;
  const [header = '', wrappedKey, iv, ciphertext, tag] = parts;
  // A direct key: nothing is wrapped.
  if (wrappedKey !== '') return null;
  let protectedHeader: Record<string, unknown>;
  try {
    protectedHeader = JSON.parse(
      decoder.decode(fromBase64Url(header) ?? new Uint8Array()),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    protectedHeader.alg !== 'dir' ||
    protectedHeader.enc !== 'A256GCM' ||
    'zip' in protectedHeader ||
    'crit' in protectedHeader
  )
    return null;
  const key = await keyFor(secret);
  const ivBytes = fromBase64Url(iv ?? '');
  const sealedText = fromBase64Url(ciphertext ?? '');
  const tagBytes = fromBase64Url(tag ?? '');
  if (!key || ivBytes?.length !== 12 || !sealedText || tagBytes?.length !== 16)
    return null;
  const sealed = new Uint8Array(sealedText.length + tagBytes.length);
  sealed.set(sealedText);
  sealed.set(tagBytes, sealedText.length);
  let claims: unknown;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: encoder.encode(header),
        tagLength: 128,
      },
      key,
      sealed,
    );
    claims = JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  const { exp, nbf, pur } = claims as Record<string, unknown>;
  if (typeof exp !== 'number' || exp * 1000 <= now) return null;
  if (typeof nbf === 'number' && nbf * 1000 > now) return null;
  if (!(Array.isArray(pur) ? pur.includes(purpose) : pur === purpose))
    return null;
  return claims as Record<string, unknown>;
}

/**
 * Whether a request comes from the owner's browser: its durable owner cookie carrying the owner
 * claim, or the toolbar's override cookie that mints it, either sealed with `secret`. Never throws:
 * anything that does not open is not the owner.
 */
export async function ownerRequest(
  headers: Headers,
  secret = process.env.FLAGS_SECRET,
  now = Date.now(),
): Promise<boolean> {
  if (!secret) return false;
  try {
    const durable = cookieValue(headers, OWNER_COOKIE);
    if (durable) {
      const values = (await opened(durable, 'values', secret, now))?.v;
      if (
        values &&
        typeof values === 'object' &&
        (values as Record<string, unknown>)[OWNER_CLAIM] === true
      )
        return true;
    }
    const overrides = cookieValue(headers, FLAG_OVERRIDES_COOKIE);
    if (!overrides) return false;
    return Boolean((await opened(overrides, 'overrides', secret, now))?.o);
  } catch {
    return false;
  }
}
