/**
 * Orchestration layer for the Phase 5 sweep. Iterates a tier slice of
 * `hmrc_company_mapping`, runs the resolver per row, applies the upgrade-only
 * decision via `decide`, and dispatches to the injected DB write functions.
 *
 * All side-effecting dependencies are injected so the orchestration is unit
 * testable. The thin CLI in `apps/web/scripts/phase5-sweep.ts` (TBD) wires the
 * real db / fetchApi / upsertProfile into these slots.
 */

import type { ExistingMapping, ProposedResolution } from './decide.ts';
import { decide } from './decide.ts';

export type Tier = 'no_match' | 'non_exact' | 'exact' | 'public_body';

export type SweepLocality = {
  townCity: string | null;
  county: string | null;
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
  lookupLocality: (organisationName: string) => Promise<SweepLocality>;
  resolveSponsor: (
    organisationName: string,
    locality: SweepLocality,
  ) => Promise<ProposedResolution>;
  applyPromotion: (
    existing: ExistingMapping,
    proposed: ProposedResolution,
    changedBy: string,
  ) => Promise<ApplyResult>;
  bumpVerifiedAt: (existing: ExistingMapping) => Promise<void>;
  enqueueReview: (
    existing: ExistingMapping,
    proposed: ProposedResolution,
    reason: string,
    detectedBy: string,
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export type SweepSummary = {
  selected: number;
  updated: number;
  bumped: number;
  queued: number;
  lockMissed: number;
  errored: number;
};

const CHANGED_BY: Record<Tier, string> = {
  no_match: 'phase5_sweep_no_match',
  non_exact: 'phase5_sweep_non_exact',
  exact: 'phase5_sweep_exact',
  public_body: 'phase5_sweep_public_body',
};

/** Default inter-row sleep when the caller doesn't override via `config.delayMs`.
 *  Sized for the resolver's post-patch worst case of 4 CH calls per row
 *  (1 search + 3 Tier-B profile fetches when Tier-A returned only inactive
 *  candidates). 4 calls / 2200ms ≈ 1.8 req/sec, under CH's 600/5min budget.
 *  CLI can override via `PHASE5_DELAY_MS` env var without redeploying. */
export const DEFAULT_DELAY_MS = 2200;

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
    queued: 0,
    lockMissed: 0,
    errored: 0,
  };

  const changedBy = CHANGED_BY[config.tier];
  const delayMs = config.delayMs ?? DEFAULT_DELAY_MS;

  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) await deps.sleep(delayMs);
    const row = rows[i];
    try {
      const locality = await deps.lookupLocality(row.organisationName);
      const proposed = await deps.resolveSponsor(
        row.organisationName,
        locality,
      );
      const decision = decide(row, proposed);

      if (decision.action === 'update') {
        const result = await deps.applyPromotion(row, proposed, changedBy);
        if (result.ok) summary.updated += 1;
        else summary.lockMissed += 1;
      } else if (decision.action === 'bump') {
        await deps.bumpVerifiedAt(row);
        summary.bumped += 1;
      } else if (decision.action === 'queue') {
        await deps.enqueueReview(row, proposed, decision.reason, changedBy);
        await deps.bumpVerifiedAt(row);
        summary.queued += 1;
      }
    } catch (err) {
      summary.errored += 1;
      console.error(
        `[phase5-sweep] row "${row.organisationName}" errored:`,
        err,
      );
    }
  }

  return summary;
}
