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

import { companyWebsites } from '@ss/db/schema';
import { and, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';

import type { WebsiteEvidence } from './decide';

export const PUBLISHABLE_EVIDENCE: WebsiteEvidence[] = [
  'manual',
  'crn_on_page',
];

/**
 * The render gate, as one expression both readers share.
 *
 * Two surfaces ask the same question in different shapes — the detail page's
 * RPC (does THIS company have a website) and the "Has website" filter (which
 * companies do) — and they must never disagree, or the filter returns rows
 * whose page shows no link. So the gate is defined once here rather than
 * spelled out at each call site (apps/web/CLAUDE.md: prefer structural
 * impossibility over an agreement test).
 *
 * All four conditions carry weight. `verified` says the row survived
 * discovery; `checked_at` says a sweep actually fetched the URL, which status
 * alone does not imply; the evidence filter says the company identified
 * itself; and `url` can be null on a row that reached `none`.
 *
 * Renders unaliased (`"company_websites"."status"`), so a correlated EXISTS
 * must not alias the table.
 */
export function publishableWebsiteGate(): SQL {
  return and(
    eq(companyWebsites.status, 'verified'),
    isNotNull(companyWebsites.checkedAt),
    inArray(companyWebsites.evidence, PUBLISHABLE_EVIDENCE),
    isNotNull(companyWebsites.url),
  ) as SQL;
}
