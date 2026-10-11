import { addressScope, clientAddress } from './address';
import { SESSION_COOKIE } from './calls';
import { inRanges, type Ranges } from './ranges';
import { cookieValue, readSession } from './token';

/**
 * The switch, `DOCUMENT_MODE`: `observe` decides every company document and session call and logs
 * the decision, changing nothing; `enforce` acts on it. Anything else is off.
 */
export type DocumentMode = 'observe' | 'enforce';

export function documentMode(
  value = process.env.DOCUMENT_MODE,
): DocumentMode | null {
  return value === 'observe' || value === 'enforce' ? value : null;
}

/**
 * How a request is served, and why: `server` is the full document (a data call answered), `client`
 * the app shell (a data call refused). Anything that cannot be decided is `server`.
 */
export type Decision =
  | {
      render: 'server';
      why:
        | 'crawler'
        | 'session'
        | 'no crawler ranges'
        | 'no address'
        | 'no secret';
    }
  | {
      render: 'client';
      why: 'no session' | 'expired' | 'elsewhere' | 'malformed' | 'unverified';
    };

/** Decides how one request is served, from its address and its session cookie. Never throws. */
export async function decide(input: {
  headers: Headers;
  ranges: Ranges | null;
  secret: string | undefined;
  now?: number;
}): Promise<Decision> {
  const { headers, ranges, secret, now } = input;
  if (!ranges) return { render: 'server', why: 'no crawler ranges' };
  const address = clientAddress(headers);
  const scope = address === null ? null : addressScope(address);
  if (address === null || scope === null)
    return { render: 'server', why: 'no address' };
  if (inRanges(ranges, address)) return { render: 'server', why: 'crawler' };
  if (!secret) return { render: 'server', why: 'no secret' };
  const session = await readSession(cookieValue(headers, SESSION_COOKIE), {
    scope,
    secret,
    now,
  });
  switch (session.status) {
    case 'valid':
      return session.standing === 'person'
        ? { render: 'server', why: 'session' }
        : { render: 'client', why: 'unverified' };
    case 'absent':
      return { render: 'client', why: 'no session' };
    default:
      return { render: 'client', why: session.status };
  }
}
