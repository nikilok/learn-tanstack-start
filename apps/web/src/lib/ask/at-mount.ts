// What the home route learns of asking once it has mounted, from what only
// the browser holds: the /download preview's frame, the owner hint
// (lib/ask/access-hint) and the time a waiting device was last told
// (lib/ask/cooldown). Never in the first render, which must match the
// server's.

import type { AskAccess } from './session';

/** What is read at mount: whether the page is the /download preview, whether it carries the owner hint, whether asking is public, and the time kept for a waiting device. */
export type AtMount = {
  preview: boolean;
  owner: boolean;
  open: boolean;
  stored: number | null;
};

/**
 * Whether asking is offered, and the wait the page shows. The preview never
 * asks. The owner asks without a token budget, so a time kept from a visit
 * made without the cookie is not theirs to wait out; anyone else is shown it.
 */
export function askAtMount({ preview, owner, open, stored }: AtMount): {
  access: AskAccess;
  cooldown: number | null;
} {
  return {
    access: !preview && (owner || open) ? 'open' : 'off',
    cooldown: owner ? null : stored,
  };
}
