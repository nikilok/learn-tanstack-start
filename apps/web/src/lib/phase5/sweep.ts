/**
 * Orchestration layer for the Phase 5 sweep. Iterates a tier slice of
 * `hmrc_company_mapping`, runs the resolver per row, applies the upgrade-only
 * decision via `decide`, and dispatches to the injected DB write functions.
 *
 * Inline same-rank resolution: when `decide` returns `inline_score`, the
 * orchestrator runs `compareForInlineResolution` over the existing + proposed
 * CH profiles and dispatches to applyPromotion / bumpVerifiedAt / warn-and-
 * bump. No queue, no follow-up job — the decision lands in the same sweep run.
 *
 * A join never moves alone between two records of one overseas company (the
 * company and the UK establishments listed under it): when the proposal is
 * the open establishment of the company the row is joined to, the whole
 * company moves (every join, its website row and its answers) through
 * `moveToEstablishment`; on any other pair of its records the row stays where
 * it is.
 *
 * All side-effecting dependencies are injected so the orchestration is unit
 * testable. The thin CLI in `apps/web/scripts/phase5-sweep.ts` wires the
 * real db / Companies House fetch / upsertProfile into these slots.
 */

import type {
  EstablishmentMove,
  SweepMove,
} from '../hmrc-ch/establishment-move.ts';
import { isOpenEstablishmentOf } from '../hmrc-ch/uk-establishment.ts';
import type { CompareCandidate } from './compare-candidates.ts';
import { compareForInlineResolution } from './compare-candidates.ts';
import type {
  CHFullProfile,
  ExistingMapping,
  ProposedResolution,
} from './decide.ts';
import { decide } from './decide.ts';
import type { ScorerSponsor } from './score-candidate.ts';

export type Tier = 'no_match' | 'non_exact' | 'exact' | 'public_body';

export type SweepSponsor = {
  townCity: string | null;
  county: string | null;
  route: string | null;
};

export type SweepConfig = {
  tier: Tier;
  maxRows: number;
  /** Inter-row sleep in ms. Default `DEFAULT_DELAY_MS` (2200) gives ~1.8
   *  req/sec at the resolver's worst-case 4 CH calls/row. CLI can override
   *  via the `PHASE5_DELAY_MS` env var without redeploying. */
  delayMs?: number;
};

export type ApplyResult = { ok: true } | { ok: false; reason: 'lock_missed' };

export type SweepDeps = {
  selectRows: (tier: Tier, maxRows: number) => Promise<ExistingMapping[]>;
  lookupSponsor: (organisationName: string) => Promise<SweepSponsor>;
  resolveSponsor: (
    organisationName: string,
    locality: SweepSponsor,
  ) => Promise<ProposedResolution>;
  /** Fetch the cached CH profile for the existing mapping's company_number.
   *  Returns null when the row hasn't been cached (rare — the sweep only
   *  calls this for `inline_score` rows, whose existing was a previous
   *  mapping winner and should already be in `companies_house_profiles`). */
  getProfile: (companyNumber: string) => Promise<CHFullProfile | null>;
  applyPromotion: (
    existing: ExistingMapping,
    proposed: ProposedResolution,
    changedBy: string,
  ) => Promise<ApplyResult>;
  /** Touch `verified_at = now()` behind the optimistic lock. Reports
   *  lock_missed when the lock matched zero rows so the sweep counts the
   *  skipped write instead of assuming success. */
  bumpVerifiedAt: (existing: ExistingMapping) => Promise<ApplyResult>;
  /** Move the overseas company the named sponsor's row is joined to onto its
   *  establishment: every join with its method, its website row and its
   *  answers, or nothing. */
  moveToEstablishment: (
    move: EstablishmentMove,
    organisationName: string,
    changedBy: string,
  ) => Promise<SweepMove>;
  sleep: (ms: number) => Promise<void>;
};

export type SweepSummary = {
  selected: number;
  updated: number;
  bumped: number;
  /** Same-rank cases the inline scorer decided (swap or keep). */
  inlineResolved: number;
  /** Same-rank cases the scorer punted on; row bumped with a warning. */
  inlineInconclusive: number;
  /** `manual_conflict` / `public_body_conflict` rows; bumped with a warning. */
  warned: number;
  /** Writes (promotions or bumps) the optimistic lock skipped. Occasional
   *  misses are concurrency noise; a high rate means the lock is broken. */
  lockMissed: number;
  errored: number;
  /** Companies moved from an overseas record onto its UK establishment. Each
   *  such row is also counted by what became of it afterwards. */
  establishmentMoved: number;
  /** Rows left where they are though another record of the same overseas
   *  company was proposed; row bumped. `establishmentHeldBy` counts them by
   *  what held them. */
  establishmentHeld: number;
  establishmentHeldBy: Record<string, number>;
  /** Rows whose overseas company lists several open establishments, so the
   *  match stayed on the overseas record. Also counted by their outcome. */
  severalEstablishments: number;
};

const CHANGED_BY: Record<Tier, string> = {
  no_match: 'phase5_sweep_no_match',
  non_exact: 'phase5_sweep_non_exact',
  exact: 'phase5_sweep_exact',
  public_body: 'phase5_sweep_public_body',
};

/** Default inter-row sleep when the caller doesn't override via `config.delayMs`.
 *  Sized for the common worst case of 4 CH calls per row (1 search + 3 Tier-B
 *  profile fetches when Tier-A/A2 returned only inactive candidates):
 *  4 / 2200ms ≈ 1.8 req/sec under CH's 600/5min budget. Embedded-number rows
 *  add a 5th call but are <1% of the register, so they don't move the average
 *  — and observed tier-1 runs already take 183–212 min of the workflow's
 *  timeout, so the delay must not grow. CLI can override via `PHASE5_DELAY_MS`
 *  env var without redeploying. */
const DEFAULT_DELAY_MS = 2200;

/** Adapt a `CHFullProfile` (as returned by the resolver or read from the
 *  cache) into the structural shape the comparer reads. */
function toCompareCandidate(profile: CHFullProfile): CompareCandidate {
  return {
    company_name: profile.company_name,
    company_status: profile.company_status ?? null,
    type: (profile.type as string | undefined) ?? null,
    registered_office_address:
      (profile.registered_office_address as
        | { locality?: string | null }
        | undefined) ?? null,
    previous_company_names:
      (profile.previous_company_names as { name: string }[] | undefined) ??
      null,
  };
}

function toScorerSponsor(sponsor: SweepSponsor): ScorerSponsor {
  return { route: sponsor.route, townCity: sponsor.townCity };
}

/** What a row held for being on another record of the proposal's company is counted under. */
const OTHER_RECORD = 'other_record';

/** The move a proposal asks for when it is the open UK establishment of the very company the row is joined to, by the register's own link; null otherwise. An owner's join is never moved. */
function ownEstablishmentMove(
  row: ExistingMapping,
  proposed: ProposedResolution,
): EstablishmentMove | null {
  const { companyNumber } = row;
  const establishmentNumber = proposed.companyNumber;
  if (
    row.matchMethod === 'manual' ||
    companyNumber === null ||
    proposed.verdict !== 'verified' ||
    proposed.profile === undefined ||
    establishmentNumber === null ||
    establishmentNumber === companyNumber ||
    !isOpenEstablishmentOf(proposed.profile, companyNumber)
  ) {
    return null;
  }
  return { companyNumber, establishmentNumber };
}

/** Whether the row sits on another record of the one overseas company the proposal's name matched: that company itself, or an establishment the register lists under it. */
function isOtherRecordOfCompany(
  row: ExistingMapping,
  proposed: ProposedResolution,
): boolean {
  const { companyNumber } = row;
  const { overseas } = proposed;
  return (
    row.matchMethod !== 'manual' &&
    companyNumber !== null &&
    overseas !== undefined &&
    proposed.companyNumber !== companyNumber &&
    (overseas.companyNumber === companyNumber ||
      overseas.establishments.includes(companyNumber))
  );
}

/** Run a single tier sweep against the injected dependencies. */
export async function sweep(
  config: SweepConfig,
  deps: SweepDeps,
): Promise<SweepSummary> {
  const rows = await deps.selectRows(config.tier, config.maxRows);
  const summary: SweepSummary = {
    selected: rows.length,
    updated: 0,
    bumped: 0,
    inlineResolved: 0,
    inlineInconclusive: 0,
    warned: 0,
    lockMissed: 0,
    errored: 0,
    establishmentMoved: 0,
    establishmentHeld: 0,
    establishmentHeldBy: {},
    severalEstablishments: 0,
  };

  const changedBy = CHANGED_BY[config.tier];
  const delayMs = config.delayMs ?? DEFAULT_DELAY_MS;
  /** The overseas companies this run has moved, each with its establishment. A dry run moves none, and counts each once all the same. */
  const movedTo = new Map<string, string>();

  /** Bump behind the lock; a miss counts as lockMissed, not as success. */
  const bumpAndCount = async (r: ExistingMapping): Promise<boolean> => {
    const result = await deps.bumpVerifiedAt(r);
    if (!result.ok) summary.lockMissed += 1;
    return result.ok;
  };

  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) await deps.sleep(delayMs);
    const selected = rows[i];
    try {
      const sponsor = await deps.lookupSponsor(selected.organisationName);
      const proposed = await deps.resolveSponsor(
        selected.organisationName,
        sponsor,
      );
      if (proposed.overseas?.link === 'several') {
        summary.severalEstablishments += 1;
      }

      let row = selected;
      const move = ownEstablishmentMove(selected, proposed);
      let held: string | null = null;
      if (
        move &&
        movedTo.get(move.companyNumber) === move.establishmentNumber
      ) {
        // An earlier row of this run moved the company, this join with it.
        row = { ...selected, companyNumber: move.establishmentNumber };
      } else if (move) {
        const done = await deps.moveToEstablishment(
          move,
          selected.organisationName,
          `${changedBy}_establishment`,
        );
        if (done.kind === 'changed') {
          summary.lockMissed += 1;
          continue;
        }
        if (done.kind === 'held') {
          held = done.reason;
        } else {
          summary.establishmentMoved += 1;
          movedTo.set(move.companyNumber, move.establishmentNumber);
          // The join now sits on the establishment; the rest is decided from there.
          row = { ...selected, companyNumber: move.establishmentNumber };
        }
      } else if (isOtherRecordOfCompany(selected, proposed)) {
        // Neither the tie-break nor a promotion may take the join and leave its website row behind.
        held = OTHER_RECORD;
      }
      if (held !== null) {
        // Bumped, so a company that cannot move does not lead every later run.
        if (await bumpAndCount(selected)) {
          summary.establishmentHeld += 1;
          summary.establishmentHeldBy[held] =
            (summary.establishmentHeldBy[held] ?? 0) + 1;
        }
        continue;
      }
      const decision = decide(row, proposed);

      if (decision.action === 'update') {
        const result = await deps.applyPromotion(row, proposed, changedBy);
        if (result.ok) summary.updated += 1;
        else summary.lockMissed += 1;
      } else if (decision.action === 'bump') {
        if (await bumpAndCount(row)) summary.bumped += 1;
      } else if (decision.action === 'log_and_bump') {
        console.warn(
          `[phase5-sweep] ${decision.reason} for "${row.organisationName}" — bumping without write`,
        );
        if (await bumpAndCount(row)) summary.warned += 1;
      } else if (decision.action === 'inline_score') {
        // Same-rank tie: existing and proposed are both verified at the same
        // ladder rank with different company_numbers. Score them on
        // sponsor-fit + succession + UK-presence to break the tie.
        const existingNumber = row.companyNumber;
        const existingProfile = existingNumber
          ? await deps.getProfile(existingNumber)
          : null;
        const proposedProfile = proposed.profile ?? null;

        if (!existingProfile || !proposedProfile) {
          console.warn(
            `[phase5-sweep] inline_score missing profile for "${row.organisationName}" — bumping`,
          );
          if (await bumpAndCount(row)) summary.inlineInconclusive += 1;
          continue;
        }

        const cmp = compareForInlineResolution(
          toCompareCandidate(existingProfile),
          toCompareCandidate(proposedProfile),
          toScorerSponsor(sponsor),
        );

        if (cmp.action === 'promote') {
          const result = await deps.applyPromotion(row, proposed, changedBy);
          if (result.ok) summary.inlineResolved += 1;
          else summary.lockMissed += 1;
        } else if (cmp.action === 'keep') {
          if (await bumpAndCount(row)) summary.inlineResolved += 1;
        } else {
          console.warn(
            `[phase5-sweep] inline_score inconclusive for "${row.organisationName}" (s_e=${cmp.s_e} s_p=${cmp.s_p})`,
          );
          if (await bumpAndCount(row)) summary.inlineInconclusive += 1;
        }
      }
    } catch (err) {
      summary.errored += 1;
      console.error(
        `[phase5-sweep] row "${selected.organisationName}" errored:`,
        err,
      );
    }
  }

  return summary;
}
