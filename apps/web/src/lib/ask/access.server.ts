// Who may ask. One seam: the server fns call this first and nothing else
// decides it, so when accounts exist the check changes here alone.

import { isOwnerRequest } from '../../owner.server';

type Env = { NODE_ENV?: string; ASK_LOCAL_OPEN?: string };

/**
 * Whether the current request may ask: the owner, by the owner cookie. A
 * development run opens it to every visitor with `ASK_LOCAL_OPEN=1`; any other
 * NODE_ENV, or none, ignores that switch whatever it says.
 */
export async function mayAsk(
  env: Env = process.env,
  owner: () => Promise<boolean> = isOwnerRequest,
): Promise<boolean> {
  if (env.NODE_ENV === 'development' && env.ASK_LOCAL_OPEN === '1') return true;
  return owner();
}
