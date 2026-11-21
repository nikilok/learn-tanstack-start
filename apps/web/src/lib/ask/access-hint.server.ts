// Sets the owner hint for the home document itself, so an owner's first
// page already knows asking is open and nobody else ever mints to find out.

import { ensureOwnerHint, expireOwnerHint } from '../../owner.server';
import { askStanding } from './access.server';

/**
 * Leaves the readable hint on a request that may ask and takes it off one
 * that may not; a request carrying neither credential nor hint is left
 * untouched, so the public document gains no header. While asking is public
 * a visitor's document needs no hint and is left as it is: the page knows
 * from its build (lib/ask/public).
 */
export async function markAskAccess(
  standing: typeof askStanding = askStanding,
  hint = { ensure: ensureOwnerHint, expire: expireOwnerHint },
): Promise<void> {
  const asks = await standing();
  if (asks === 'public') return;
  if (asks !== null) hint.ensure();
  else hint.expire();
}
