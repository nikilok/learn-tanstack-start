// Who may ask. One seam: the server fns call this first and nothing else
// decides it, so when accounts exist the check changes here alone.

import { isOwnerRequest } from '../../owner.server';
import { ASK_PUBLIC } from './public';

type Env = { NODE_ENV?: string; ASK_LOCAL_OPEN?: string };

/**
 * Who a request asks as: the `owner`, by the owner cookie; a visitor of a
 * `local` run opened to all; a visitor while asking is `public`; or nobody.
 * Only the owner asks without a token budget (lib/ask/admission.server).
 */
export type AskStanding = 'owner' | 'local' | 'public' | null;

/**
 * The current request's standing. A development run is opened to every
 * visitor with `ASK_LOCAL_OPEN=1`; any other NODE_ENV, or none, ignores that
 * switch whatever it says.
 */
export async function askStanding(
  env: Env = process.env,
  owner: () => Promise<boolean> = isOwnerRequest,
  open: boolean = ASK_PUBLIC,
): Promise<AskStanding> {
  if (await owner()) return 'owner';
  if (env.NODE_ENV === 'development' && env.ASK_LOCAL_OPEN === '1')
    return 'local';
  return open ? 'public' : null;
}

/** Whether the current request may ask at all, whatever its standing. */
export async function mayAsk(
  env: Env = process.env,
  owner: () => Promise<boolean> = isOwnerRequest,
  open: boolean = ASK_PUBLIC,
): Promise<boolean> {
  return (await askStanding(env, owner, open)) !== null;
}
