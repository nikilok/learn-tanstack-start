import { addressScope, clientAddress } from './address';
import { SESSION_COOKIE } from './calls';
import { inRanges, type Ranges } from './ranges';
import { cookieValue, readSession } from './token';

/**
 * The switch, `DOCUMENT_MODE`: `observe` decides every company document and session call and logs
 * the decision, changing nothing; `enforce` acts on it. Anything else is off.
 */
export type DocumentMode = 'observe' | 'enforce';

/** The switch as set: `observe` or `enforce`, or null for off. */
export function documentMode(
  value = process.env.DOCUMENT_MODE,
): DocumentMode | null {
  return value === 'observe' || value === 'enforce' ? value : null;
}

/**
 * How a company document is served, and why: `server` is the full document, `client` the app
 * shell, whose data reaches the browser through its own data call. Anything that cannot be
 * decided is `server`.
 */
export type DocumentDecision =
  | { render: 'server'; why: 'crawler' | 'no crawler ranges' | 'no address' }
  | { render: 'client'; why: 'visitor' };

/**
 * Decides how one company document is served, from its address alone: in full to a crawler
 * address, and as the app shell to anyone else, whatever cookie they hold. Never throws.
 */
export function decideDocument(input: {
  headers: Headers;
  ranges: Ranges | null;
}): DocumentDecision {
  const { headers, ranges } = input;
  if (!ranges) return { render: 'server', why: 'no crawler ranges' };
  const address = clientAddress(headers);
  if (address === null || addressScope(address) === null)
    return { render: 'server', why: 'no address' };
  if (inRanges(ranges, address)) return { render: 'server', why: 'crawler' };
  return { render: 'client', why: 'visitor' };
}

/**
 * Whether a company data call goes through, and why: `server` answers it, `client` refuses it.
 * Anything that cannot be decided is `server`.
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

/** Decides whether one company data call goes through, from its address and its session cookie. Never throws. */
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
