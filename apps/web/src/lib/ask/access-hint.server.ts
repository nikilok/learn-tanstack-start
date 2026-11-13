// Sets the owner hint for the home document itself, so an owner's first
// page already knows asking is open and nobody else ever mints to find out.

import { ensureOwnerHint, expireOwnerHint } from '../../owner.server';
import { mayAsk } from './access.server';

/**
 * Leaves the readable hint on a request that may ask and takes it off one
 * that may not; a request carrying neither credential nor hint is left
 * untouched, so the public document gains no header.
 */
export async function markAskAccess(): Promise<void> {
  if (await mayAsk()) ensureOwnerHint();
  else expireOwnerHint();
}
