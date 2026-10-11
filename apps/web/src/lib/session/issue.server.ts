import {
  type BrowserVerdict,
  browserVerdict,
  enforcing,
} from '../device/browser-check.server';
import { addressScope, clientAddress } from './address';
import { SESSION_COOKIE, SESSION_HINT_COOKIE } from './calls';
import { type DocumentMode, documentMode } from './decide';
import { crawlerRanges, inRanges, type Ranges } from './ranges';
import {
  cookieValue,
  issueSession,
  readSession,
  SESSION_RENEW_SECONDS,
  SESSION_TTL_SECONDS,
  SESSION_UNCHECKED_TTL_SECONDS,
  type SessionStanding,
  sessionSecret,
} from './token';

/** What the browser is told: `ok` (it holds a session), `refused`, or `off` (none are issued). */
export type SessionAnswer = 'ok' | 'refused' | 'off';

/** A `Set-Cookie` value for one of the session's cookies, sent site-wide over https only. */
function cookie(
  name: string,
  value: string,
  maxAge: number,
  httpOnly: boolean,
) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}`;
}

/** The endpoint's JSON answer, never cached, setting any cookies given. */
function answer(session: SessionAnswer, cookies: readonly string[] = []) {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
  });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify({ session }), { status: 200, headers });
}

/** What can be swapped out, for tests. Absent, each is read as production reads it. */
export type IssueDeps = {
  mode?: DocumentMode | null;
  secret?: string;
  now?: number;
  verdict?: () => Promise<BrowserVerdict | 'unchecked'>;
  ranges?: () => Promise<Ranges | null>;
  /** Whether the check's verdict is acted on (`BROWSER_CHECK_ENFORCE`). */
  enforce?: boolean;
};

/**
 * The answer to `POST /api/session`: confirms a session held for this address with time to run,
 * or issues one if the browser check passes. A check that cannot run issues a short session, and
 * a crawler address is answered `off` without one.
 *
 * A failed check refuses only under `enforce` with `BROWSER_CHECK_ENFORCE` on; a session still
 * held is then left to run out, not taken away. Under `observe` a failed check is issued an
 * `unverified` session, which the edge treats as none. Never throws.
 */
export async function sessionResponse(
  headers: Headers,
  deps: IssueDeps = {},
): Promise<Response> {
  const mode = 'mode' in deps ? deps.mode : documentMode();
  const secret = 'secret' in deps ? deps.secret : sessionSecret();
  const now = deps.now ?? Date.now();
  const address = clientAddress(headers);
  const scope = address === null ? null : addressScope(address);
  if (!mode || !secret || address === null || scope === null)
    return answer('off');

  const ranges = await (deps.ranges ?? crawlerRanges)();
  if (ranges && inRanges(ranges, address)) {
    console.info('[session] crawler address: none issued');
    return answer('off');
  }

  const held = await readSession(cookieValue(headers, SESSION_COOKIE), {
    scope,
    secret,
    now,
  });
  if (
    held.status === 'valid' &&
    held.standing === 'person' &&
    held.expires - now / 1000 > SESSION_RENEW_SECONDS
  )
    return answer('ok');

  const said = await (deps.verdict ?? (() => browserVerdict('session')))();
  const automated = said === 'automated' || said === 'verified crawler';
  const refuse =
    automated && mode === 'enforce' && (deps.enforce ?? enforcing());
  console.info(
    `[session] verdict: ${said}${automated && !refuse ? ' (not enforced)' : ''}`,
  );
  if (refuse) {
    if (held.status === 'valid' && held.standing === 'person')
      return answer('ok');
    return answer('refused', [
      cookie(SESSION_COOKIE, '', 0, true),
      cookie(SESSION_HINT_COOKIE, '', 0, false),
    ]);
  }

  const standing: SessionStanding =
    automated && mode === 'observe' ? 'unverified' : 'person';
  const ttl =
    said === 'unchecked' ? SESSION_UNCHECKED_TTL_SECONDS : SESSION_TTL_SECONDS;
  const { value, expires } = await issueSession({
    scope,
    standing,
    secret,
    now,
    ttlSeconds: ttl,
  });
  return answer('ok', [
    cookie(SESSION_COOKIE, value, ttl, true),
    cookie(SESSION_HINT_COOKIE, String(expires), ttl, false),
  ]);
}
