// Sets the owner hint for the home document itself, so an owner's first
// page already knows asking is open and nobody else ever mints to find out.

import { ensureOwnerHint, expireOwnerHint } from '../../owner.server';
import { askStanding } from './access.server';

/**
 * Leaves the readable hint on the owner's request, and a local run's, and
 * takes it off any other; a request carrying neither credential nor hint is
 * left untouched, so the public document gains no header. While asking is
 * public a visitor's document needs no hint: the page knows from its build
 * (lib/ask/public), and a hint left from a credential that has lapsed would
 * have it read as the owner's.
 */
export async function markAskAccess(
  standing: typeof askStanding = askStanding,
  hint = { ensure: ensureOwnerHint, expire: expireOwnerHint },
): Promise<void> {
  const asks = await standing();
  if (asks === 'owner' || asks === 'local') hint.ensure();
  else hint.expire();
}
