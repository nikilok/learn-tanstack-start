import { getCookie, setCookie } from '@tanstack/react-start/server';
import { decryptFlagValues, encryptFlagValues } from 'flags';

import { decryptFlagOverrides, FLAG_OVERRIDES_COOKIE } from './flags.server';

// Bootstrap-and-upgrade owner identity — trust chain, kill-switch (rotate
// FLAGS_SECRET), and cache invariants documented in CLAUDE.md "/download owner gating".

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

/**
 * Owner check for the current request: our durable cookie wins; otherwise a
 * valid toolbar override cookie (proof of Vercel team membership) grants
 * access and is upgraded on the spot to the durable httpOnly cookie — one
 * Explorer Apply per browser per credential lifetime (365d). Never throws:
 * auth failures resolve to anonymous, and a failed mint still honours the
 * toolbar proof for this request.
 */
export async function isOwnerRequest(): Promise<boolean> {
  if (await hasOwnerCookie()) return true;
  const overrides = await decryptFlagOverrides(
    getCookie(FLAG_OVERRIDES_COOKIE),
  );
  if (!overrides) return false;
  try {
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
  } catch (err) {
    console.error('[owner] durable cookie mint failed', err);
  }
  return true;
}
