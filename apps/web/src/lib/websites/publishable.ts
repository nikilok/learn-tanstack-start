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
 * `registry_confirmed` is a registry row whose page carries the company's
 * REGISTERED OFFICE POSTCODE. Measured against the shipped rule on 97
 * confirmed rows drawn fresh (2026-08-01):
 *
 *   correct 95, wrong 0, unsure 2 — 97.9%, 95% lower bound 94.0%
 *
 * That is INCONCLUSIVE by this repo's own scorer, which wants the lower bound
 * above 95% and allows one bad label at n=97. It ships anyway, as an explicit
 * product judgement rather than a measurement result, and the reasoning is
 * recorded here so nobody later reads 94.0% as having cleared a bar:
 *
 *   - Zero wrong rows in 97. The verdict is arithmetic about sample size, not
 *     observed error, and the optimistic figure is 100%.
 *   - A UK postcode covers roughly fifteen addresses. A company's exact
 *     registered postcode appearing on a site is not a coincidence that needs
 *     explaining away, which is the domain fact the statistical bar cannot
 *     encode.
 *   - The rule's only real failure mode was measured directly: 12 of the 97
 *     sit at a registered office shared with another company holding a
 *     different website, and all 12 independently carry their own name in the
 *     domain or its initialism. It produced no false positive.
 *   - Of the 18 hardest rows — no company name anywhere on the site — 16 show
 *     the FULL registered street address, not merely the postcode. The signal
 *     in practice is stronger than the rule demands.
 *
 * The two unresolvable rows (I CARE (GB) LIMITED, DARAM CARE LTD) had no name
 * and only the postcode. Neither was shown to be wrong; neither could be
 * confirmed.
 *
 * Bare `registry` is NOT here and is not a candidate: the same exercise put it
 * at 90% overall, and the rows it would add beyond this tier were 14/29.
 *
 * This rung is REVOCABLE, so the list is not a one-way door — the sweep lowers
 * it back when a page stops showing the address.
 */

import { companyWebsites } from '@ss/db/schema';
import { and, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';

import type { WebsiteEvidence } from './decide';

export const PUBLISHABLE_EVIDENCE: WebsiteEvidence[] = [
  'manual',
  'crn_on_page',
  'registry_confirmed',
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

/**
 * States whose company still OWNS its extracted answers — deliberately ONE
 * notch wider than the render gate.
 *
 * The revalidation sweep flips a `verified` row to `unreachable` after a
 * SINGLE failed fetch (revalidate.ts: "ONE failure path, no exemptions"), and
 * schema.ts documents that state as transient — "returns to `verified` on the
 * next pass that answers". The render gate correctly stops showing the link
 * during that blip. But the profiles corpus must NOT archive-and-delete a
 * company's whole answer set over one bad night, then re-extract it at Gemma
 * cost when the status self-heals. So retention tolerates `unreachable` and
 * fires only on genuine loss: `dead` (written off after two consecutive
 * failures), `none`/`candidate`, an evidence demotion below the publishable
 * tiers, or a null URL. It never renders anything — the render gate is the
 * only publish decision.
 */
export function answersRetentionGate(): SQL {
  return and(
    inArray(companyWebsites.status, ['verified', 'unreachable']),
    isNotNull(companyWebsites.checkedAt),
    inArray(companyWebsites.evidence, PUBLISHABLE_EVIDENCE),
    isNotNull(companyWebsites.url),
  ) as SQL;
}
