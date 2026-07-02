import { getCookie, setCookie } from '@tanstack/react-start/server';
import { decryptFlagValues, decryptOverrides, encryptFlagValues } from 'flags';

// Owner identity via Vercel-toolbar bootstrap-and-upgrade. The toolbar's
// override cookie (minted by Vercel only for verified team members, sealed
// with FLAGS_SECRET) proves team membership but expires weekly and is
// rewritten on every Explorer Apply — so the first time we see a valid one we
// mint our own durable httpOnly cookie and trust that from then on. Rotating
// FLAGS_SECRET revokes every credential of both kinds at once.

const OWNER_COOKIE = 'ss-owner';
const OWNER_CLAIM = 'ss-owner';
const OWNER_TTL_SECONDS = 365 * 24 * 60 * 60;

/** True when the request carries our durable owner cookie and it decrypts to the owner claim. */
async function hasOwnerCookie(): Promise<boolean> {
  const value = getCookie(OWNER_COOKIE);
  if (!value) return false;
  try {
    const claims = await decryptFlagValues(value, process.env.FLAGS_SECRET);
    return claims?.[OWNER_CLAIM] === true;
  } catch {
    return false; // tampered or expired — treat as anonymous
  }
}

/** True when the request carries a valid signed Flags Explorer override cookie — proof this browser passed the toolbar's team-membership auth. */
async function hasToolbarProof(): Promise<boolean> {
  const value = getCookie('vercel-flag-overrides');
  if (!value) return false;
  try {
    return Boolean(await decryptOverrides(value, process.env.FLAGS_SECRET));
  } catch {
    return false;
  }
}

/**
 * Owner check for the current request: our durable cookie wins; otherwise a
 * valid toolbar cookie both grants access and is upgraded on the spot to the
 * durable httpOnly cookie (bootstrap — one Explorer Apply per browser, ever).
 */
export async function isOwnerRequest(): Promise<boolean> {
  if (await hasOwnerCookie()) return true;
  if (!(await hasToolbarProof())) return false;
  const token = await encryptFlagValues(
    { [OWNER_CLAIM]: true },
    process.env.FLAGS_SECRET,
    '365d',
  );
  setCookie(OWNER_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: OWNER_TTL_SECONDS,
  });
  return true;
}
