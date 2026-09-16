import { getCookie, setCookie } from '@tanstack/react-start/server';

import {
  mintSessionToken,
  newSessionId,
  SESSION_MAX_AGE_MS,
  verifySessionToken,
} from './lib/session/token.server';

// The visitor session cookie — cookie IO only; every rule about the token itself lives in
// lib/session/token.server.ts, where it is tested. Same shape as owner.server.ts's cookie,
// under its own secret so the two can be rotated independently.

const SESSION_COOKIE = 'ss-session';

let warnedMissingSecret = false;

/**
 * The current request's session, minting and setting the cookie when there is none or the one
 * presented no longer verifies. `fresh` says a cookie was just issued on this response.
 *
 * Null when SESSION_SECRET is unset — the feature is simply off, said once in the log — and
 * null on any failure. Never throws: a session is an accounting handle, not something the page
 * depends on to render, so nothing here may take a request down.
 *
 * Call it from an RPC handler, never from a document loader: a `Set-Cookie` on an SSR response
 * stops the edge caching that document, and company pages are cached for 30 days by design.
 */
export function ensureSession(
  now = Date.now(),
): { id: string; fresh: boolean } | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (!warnedMissingSecret) {
      console.warn('[session] SESSION_SECRET is unset — sessions are off');
      warnedMissingSecret = true;
    }
    return null;
  }
  try {
    const presented = getCookie(SESSION_COOKIE);
    const verified = presented
      ? verifySessionToken(secret, presented, now)
      : null;
    if (verified) return { id: verified.id, fresh: false };
    const id = newSessionId();
    setCookie(SESSION_COOKIE, mintSessionToken(secret, id, now), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
    return { id, fresh: true };
  } catch (err) {
    console.error('[session] could not read or issue the session cookie', err);
    return null;
  }
}
