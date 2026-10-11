import {
  type BrowserVerdict,
  browserVerdict,
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
  type SessionStanding,
  sessionSecret,
} from './token';

/** What the browser is told: `ok` (it holds a session), `refused`, or `off` (none are issued). */
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
  ranges?: () => Promise<Ranges | null>;
};

/**
 * The answer to `POST /api/session`: confirms a session held for this address with time to run,
 * or issues one if the browser check passes (or cannot run). Under `observe` a failed check is
 * issued an `unverified` session, which the edge treats as none. A crawler address is answered
 * `off` without a check: it is served in full by address. Never throws.
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
