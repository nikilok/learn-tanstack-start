/**
 * Which rungs of the evidence ladder we are willing to publish as "this is the
 * company's website".
 *
 * Lives beside decide.ts because that is where the ladder is declared, and
 * "which rungs publish" is a statement about the ladder rather than about the
 * page that renders the result.
 *
 * Narrower than the `verified` status. `crn_on_page` is the company
 * identifying itself, not a third party vouching for it, so it needs no
 * sampling to trust. `manual` is an owner decision and outranks it.
 *
 * `registry` is NOT here yet: accurate far more often than not, but it goes
 * stale silently — two rows in the first full sweep pointed at domains that now
 * only redirect — and its precision is unmeasured. It joins this list when the
 * hand-labelled sample says so, which is a product decision, not a tidy-up.
 */

import type { WebsiteEvidence } from './decide';

export const PUBLISHABLE_EVIDENCE: WebsiteEvidence[] = [
  'manual',
  'crn_on_page',
];
