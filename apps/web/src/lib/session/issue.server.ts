import {
  type BrowserVerdict,
  browserVerdict,
  enforcing,
} from '../device/browser-check.server';
import { DEVICE_KEY_RE } from '../device/key';
import { sessionSuspendedKeys } from '../device/suspended';
import { addressScope, clientAddress } from './address';
import {
  LEGACY_SESSION_HINT_COOKIE,
  SESSION_COOKIE,
  SESSION_HINT_COOKIE,
} from './calls';
import { type DocumentMode, documentMode } from './decide';
import { ownerRequest } from './owner';
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
  /** Whether the request comes from the owner's browser (`owner.ts`). */
  owner?: () => Promise<boolean>;
  /** The device keys refused a session (`device/suspended.ts`), read once an ask. */
  suspendedKeys?: () => Promise<ReadonlySet<string>>;
};

/** The device key an ask's body names (`{ key }`), or null for a body that names none. */
export function deviceOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { key } = body as { key?: unknown };
  return typeof key === 'string' && DEVICE_KEY_RE.test(key) ? key : null;
}

/**
 * The answer to `POST /api/session`: confirms a session held for this address and device with time
 * to run, or issues one if the browser check passes. The session names the device the page sent
 * (`device`), or, when the page's key did not arrive, the device its held session already names; a
 * session naming no device, like one issued when the check cannot run, is a short one. A crawler
 * address is answered `off` without one.
 *
 * A failed check refuses only under `enforce` with `BROWSER_CHECK_ENFORCE` on; a session still
 * held is then left to run out, not taken away. A device on the sessions' list (`device/
 * suspended.ts`), asking with its key or holding a session issued to it, is refused under `enforce`
 * and its session taken away, as the edge refuses it anyway; under `observe` it is only logged.
 * Under `observe` a failed check is issued an `unverified` session, which the edge treats as none.
 * The owner's browser is issued one without asking the check. Never throws.
 */
export async function sessionResponse(
  headers: Headers,
  device: string | null,
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
  const heldDevice = held.status === 'valid' ? held.device : null;
  // The device a session issued now names: the page's, or, when its key did not arrive, the one the
  // held session names, which that session's signature vouches for.
  const bound = device ?? heldDevice;

  /** A session of `standing` for this address and device, set beside its readable hint. */
  const issue = async (standing: SessionStanding, ttl: number) => {
    const { value, expires } = await issueSession({
      scope,
      standing,
      secret,
      device: bound,
      now,
      ttlSeconds: ttl,
    });
    return answer('ok', [
      cookie(SESSION_COOKIE, value, ttl, true),
      cookie(SESSION_HINT_COOKIE, String(expires), ttl, false),
      cookie(LEGACY_SESSION_HINT_COOKIE, '', 0, false),
    ]);
  };
  /** No session: the cookies cleared, so the page does not take a hint for one. */
  const refusal = () =>
    answer('refused', [
      cookie(SESSION_COOKIE, '', 0, true),
      cookie(SESSION_HINT_COOKIE, '', 0, false),
      cookie(LEGACY_SESSION_HINT_COOKIE, '', 0, false),
    ]);

  if (await (deps.owner ?? (() => ownerRequest(headers)))()) {
    console.info('[session] owner');
    return issue('person', SESSION_TTL_SECONDS);
  }

  // The asking device, and the one the held session was issued to: either on the sessions' list is
  // no session under `enforce`, and only said under `observe`.
  const named = [device, heldDevice].filter(
    (key): key is string => key !== null,
  );
  if (named.length > 0) {
    const suspended = await (deps.suspendedKeys ?? sessionSuspendedKeys)();
    if (named.some((key) => suspended.has(key))) {
      const refuse = mode === 'enforce';
      console.info(
        `[session] suspended device${refuse ? ': refused' : ' (not enforced)'}`,
      );
      if (refuse) return refusal();
    }
  }

  // Kept while it has time to run, unless the page now names a device the session does not. One
  // naming no device is a short session, kept until it runs out while the page still names none,
  // rather than checked again on every load.
  if (
    held.status === 'valid' &&
    held.standing === 'person' &&
    (device === null || held.device === device) &&
    (held.expires - now / 1000 > SESSION_RENEW_SECONDS ||
      (held.device === null && device === null))
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
    return refusal();
  }

  // A session naming no device is a short one, checked again once it runs out.
  if (bound === null) console.info('[session] no device: short session');
  return issue(
    automated && mode === 'observe' ? 'unverified' : 'person',
    said === 'unchecked' || bound === null
      ? SESSION_UNCHECKED_TTL_SECONDS
      : SESSION_TTL_SECONDS,
  );
}
