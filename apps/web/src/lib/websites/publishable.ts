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
 *
 * `postcode_on_page` is NOT in the list: the tier publishes only in part,
 * through its own arm of the gate. A search-found row qualifies when its
 * company's registered postcode is shared by at most POSTCODE_SHARE_LIMIT
 * mapped companies (the share is defined once, in postcode-share.ts). Measured
 * on a stratified, hand-labelled sample (seed `pc-precision-2026-10-19`) drawn
 * 2026-10-19 from the 14,442 search rows at the tier: 50 rows from each of
 * share 1, 2-3, 4-10 and 11-50, and 20 from 51+. The bar is the scorer's, a
 * one-sided 95% Wilson lower bound of at least 95% with unsure counted as
 * wrong, judged on the stricter of the pooled and population-weighted bounds:
 *
 *   admitted       correct   lower bound   verdict
 *   share <= 3      99/100   95.6%         promote
 *   share <= 10    148/150   96.1%         promote (96.3% weighted)
 *   share = 1       50/50    94.9%         inconclusive: n=50 cannot clear it
 *   share <= 50    195/200   94.95%        inconclusive
 *
 * share <= 10 ships. It covered 12,211 of the 14,442 rows at the draw.
 *
 * A validation sample (seed `pc-precision-post-2026-10-20`) then drew 50
 * share <= 10 rows discovered after that draw, which brought in the
 * shard-burst cohorts the first sample barely covered: 11 SC, 3 NI, 4 OC and
 * 1 BR company. Its pass rule, set before labelling, allowed at most 2 misses,
 * and it scored 49/50. Across both samples share <= 10 is 197/200, lower bound
 * 96.3% pooled and population-weighted alike (the would-publish population:
 * 11,997 rows found before the first draw, 3,521 after).
 *
 * Labels: in the first sample the owner's on 110 rows and Claude's on the
 * other 110, with Claude labelling every row blind to the strata and to the
 * owner's verdicts. Across both samples the owner's blind audits overturned
 * none of 116 correct calls Claude made, which bounds Claude's false-correct
 * rate at 2.3% (one-sided 95%).
 *
 * Rubric (the owner's): correct is the company's own site, its parent's or its
 * subsidiary's, with Companies House PSC records deciding; a sister company's
 * site is wrong. The owner also counted sites the company shares or is listed
 * on as correct.
 *
 * What the result does not cover:
 *   - share <= 10 cleared the first sample with one failure of headroom, and
 *     partly on the owner's calls on shared and listing sites.
 *   - A company-name word in the domain looked stronger (195/196), but it was
 *     found after the fact on the same rows; it was measured on its own later,
 *     on the rows the limit holds (below).
 *   - Only `source = 'search'` was measured, so the arm admits nothing else.
 *
 * Unlike `registry_confirmed`, revalidation never demotes this tier when its
 * page stops showing the postcode: such a row keeps rendering until it fails,
 * parks or lands on a directory. A share that rises above the limit
 * unpublishes it at the next sweep run, unless its host names the company.
 *
 * Above the limit, a row publishes through its own arm when its url's host
 * names the company (the naming rule's host check, stored as named_url by
 * named-url.ts) and a sweep confirmed it live within NAMED_HOST_LIVE_DAYS.
 * Measured 2026-10-24 on a hand-labelled sample (seed
 * `held-precision-2026-10-24`) of the 3,741 verified search rows the limit
 * held, drawn at shares 11-20, 21-50 and 51+: of 80 rows whose host names the
 * company, 77 loaded and all 77 were right, lower bound 96.6% (91.0% counting
 * the 3 that did not load as wrong). The sample's 2 wrong rows, a
 * shopping-centre landlord and a trade magazine in the same building, were
 * both on hosts that name no company. 23 of the right rows are parent or group
 * sites. Labels were Claude's, with a blind second labeller agreeing on 96 of
 * the 100 held rows; the owner has not audited them. A site that stops loading
 * leaves at its next sweep check, and NAMED_HOST_LIVE_DAYS bounds how long ago
 * that check may be.
 *
 * `name_and_place` publishes through its own arm, search rows only: the
 * two-signal rule (name-and-place.ts), sealed before a fresh draw, scored
 * 65/65 on it (lower bound 96.0%) and 135/135 over three draws, and the
 * owner's blind audit passed all 22 of its picks shown. The first re-walk
 * wave, oldest companies first, picked 3 wrong sites in 11, every one on a
 * domain naming someone else (a directory, an association, a port), so the
 * rule now reads only a site whose own domain names the company: that keeps
 * 128 of the sealed draws' 133 picks and all 8 right ones in the wave. The
 * sweep holds a row back while its proof is gone.
 */

import { companyWebsites } from '@ss/db/schema';
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import type { WebsiteEvidence } from './decide';

export const PUBLISHABLE_EVIDENCE: WebsiteEvidence[] = [
  'manual',
  'crn_on_page',
  'registry_confirmed',
];

/** Most mapped companies a search-found postcode may be shared by and still publish. */
export const POSTCODE_SHARE_LIMIT = 10;

/** The measured slice of `postcode_on_page`; a NULL share fails it. */
function sharedPostcodeArm(): SQL {
  return and(
    eq(companyWebsites.source, 'search'),
    eq(companyWebsites.evidence, 'postcode_on_page'),
    lte(companyWebsites.postcodeShare, POSTCODE_SHARE_LIMIT),
  ) as SQL;
}

/** A search-found site the two-signal rule proved. */
function nameAndPlaceArm(): SQL {
  return and(
    eq(companyWebsites.source, 'search'),
    eq(companyWebsites.evidence, 'name_and_place'),
  ) as SQL;
}

/** Days since its last sweep check a named-host row may publish: past the sweep's monthly cycle, so only a stalled sweep closes it. */
export const NAMED_HOST_LIVE_DAYS = 45;

/** A search-found postcode row at any share whose own url's host names the company; a NULL share or a url changed since the check fails it. */
function namedHostArm(): SQL {
  return and(
    eq(companyWebsites.source, 'search'),
    eq(companyWebsites.evidence, 'postcode_on_page'),
    isNotNull(companyWebsites.postcodeShare),
    eq(companyWebsites.namedUrl, companyWebsites.url),
  ) as SQL;
}

/** A sweep confirmed the row live within NAMED_HOST_LIVE_DAYS. */
function confirmedRecently(): SQL {
  return gte(
    companyWebsites.checkedAt,
    sql`now() - make_interval(days => ${NAMED_HOST_LIVE_DAYS})`,
  );
}

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
 * itself, by a publishable tier, by a postcode few mapped companies share, by
 * its name and place, or by a postcode on a recently confirmed site whose host
 * names it; and `url`
 * can be null on a row that reached `none`.
 *
 * Renders unaliased (`"company_websites"."status"`), so a correlated EXISTS
 * must not alias the table.
 */
/** The arms both gates share; the status arm and the named-host arm differ between them. */
function gateWithStatusArm(statusArm: SQL, namedHost: SQL): SQL {
  return and(
    statusArm,
    isNotNull(companyWebsites.checkedAt),
    or(
      inArray(companyWebsites.evidence, PUBLISHABLE_EVIDENCE),
      sharedPostcodeArm(),
      nameAndPlaceArm(),
      namedHost,
    ),
    isNotNull(companyWebsites.url),
  ) as SQL;
}

export function publishableWebsiteGate(): SQL {
  return gateWithStatusArm(
    eq(companyWebsites.status, 'verified') as SQL,
    and(namedHostArm(), confirmedRecently()) as SQL,
  );
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
 * tiers, a postcode share above the limit on a host that does not name the
 * company, or a null URL. A stalled sweep is no loss, so the named-host arm
 * keeps its rows here however long ago their last check was. It never renders
 * anything — the render gate is the only publish decision.
 */
export const ANSWER_RETENTION_STATUSES = ['verified', 'unreachable'] as const;

export function answersRetentionGate(): SQL {
  return gateWithStatusArm(
    inArray(companyWebsites.status, [...ANSWER_RETENTION_STATUSES]) as SQL,
    namedHostArm(),
  );
}
