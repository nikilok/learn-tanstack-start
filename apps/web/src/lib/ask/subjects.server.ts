// What a visitor's asks are counted against besides the device: the network
// the request came from, and the site as a whole. Each is a row of
// `ask_usage` like a device's (lib/ask/allowance.server), under a key that is
// not a device key in form.

import { createHmac } from 'node:crypto';

import { addressScope, clientAddress } from '../session/address';

type Env = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  ENGAGE_TOKEN_SECRET?: string;
};

/** The deployment a network's and the site's totals belong to: production, a preview, or a local run. */
export function deployment(env: Env = process.env): string {
  return env.VERCEL_ENV || 'local';
}

/** The key the site's total is kept under, one for each deployment. */
export function siteKey(env: Env = process.env): string {
  return `all:${deployment(env)}`;
}

/**
 * The key a request's network is counted under: a keyed hash of the part of
 * its address a session is bound to (lib/session/address) and the deployment,
 * so the address itself is never kept. Null when the address is not known or
 * there is no secret to key it with; a development run with no address counts
 * as one network.
 */
export function networkKey(
  headers: Headers,
  env: Env = process.env,
): string | null {
  const secret = env.ENGAGE_TOKEN_SECRET;
  if (!secret) return null;
  const address = clientAddress(headers);
  const scope =
    (address === null ? null : addressScope(address)) ??
    (env.NODE_ENV === 'development' ? 'local' : null);
  if (scope === null) return null;
  const hash = createHmac('sha256', secret)
    .update(`ask-usage|${deployment(env)}|${scope}`)
    .digest('hex');
  return `net:${hash.slice(0, 32)}`;
}
