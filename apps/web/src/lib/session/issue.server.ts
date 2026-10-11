import {
  type BrowserVerdict,
  browserVerdict,
} from '../device/browser-check.server';
import { addressScope, clientAddress } from './address';
import { SESSION_COOKIE, SESSION_HINT_COOKIE } from './calls';
import { type DocumentMode, documentMode } from './decide';
import {
  cookieValue,
  issueSession,
  readSession,
  SESSION_RENEW_SECONDS,
  SESSION_TTL_SECONDS,
  type SessionStanding,
  sessionSecret,
} from './token';

/**
 * What the browser is told: `ok` when it holds a session, `refused` when the browser check named
 * it automated under `enforce`, and `off` when no session is issued at all (DOCUMENT_MODE unset,
 * no secret, or no address to bind one to).
 */
export type SessionAnswer = 'ok' | 'refused' | 'off';

function cookie(
  name: string,
  value: string,
  maxAge: number,
  httpOnly: boolean,
) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}`;
}

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
};

/**
 * The answer to `POST /api/session`: issue the browser a session bound to its address, or confirm
 * the one it holds. A session held for this address with time to run is confirmed without asking
 * the browser check, so a page load costs a check only when a session is issued.
 *
 * The check decides who gets one: a person, or a browser the check could not judge (it failed —
 * as an unreadable suspended list suspends nobody). A browser it names automated, verified
 * crawlers included, is refused under `enforce`; under `observe` it is issued an `unverified`
 * session, which the edge treats as none. Never throws.
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
  if (!mode || !secret || scope === null) return answer('off');

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
  console.info(
    `[session] browser check: ${said}${automated && mode === 'observe' ? ' (not enforced)' : ''}`,
  );
  if (automated && mode === 'enforce')
    return answer('refused', [
      cookie(SESSION_COOKIE, '', 0, true),
      cookie(SESSION_HINT_COOKIE, '', 0, false),
    ]);

  const standing: SessionStanding = automated ? 'unverified' : 'person';
  const { value, expires } = await issueSession({
    scope,
    standing,
    secret,
    now,
  });
  return answer('ok', [
    cookie(SESSION_COOKIE, value, SESSION_TTL_SECONDS, true),
    cookie(SESSION_HINT_COOKIE, String(expires), SESSION_TTL_SECONDS, false),
  ]);
}
