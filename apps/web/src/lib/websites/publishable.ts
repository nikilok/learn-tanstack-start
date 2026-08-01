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
 * `registry_confirmed` is NOT here yet, deliberately, even though the sweep
 * writes it.
 *
 * The measurement that motivated the tier stands: a 200-row hand-labelled
 * sample put bare `registry` at 90% precision (95% lower bound 86%, below the
 * floor), and that average hid two populations — rows whose page carried the
 * company's own name were 133/133 correct, rows where it appeared nowhere were
 * 14/29. A second sample of 110 corroborated rows scored 109/110.
 *
 * But that 109/110 measured a DIFFERENT rule from the one now shipping. Review
 * found the sample was scored against the post-redirect host while the sweep
 * read the pre-redirect one, and fixing that also meant tightening the rule
 * itself: word-boundary text matching, the same token required in host and
 * text, and a squashed host label. Every one of those changes the population
 * that qualifies, so the old number no longer describes it.
 *
 * The tier therefore accumulates in the database without being published, so a
 * fresh sample can be drawn against the shipped rule. When it clears the floor
 * this becomes a one-line change; if it does not, nothing was ever published on
 * a number that did not hold. Bare `registry` is not a candidate either way —
 * adding it would publish the 48% population along with the good one.
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
