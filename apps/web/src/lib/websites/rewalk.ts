/**
 * Re-walking rows search discovery has already settled, at zero search credits:
 * a `none` row's banked results go through discovery's own settle step, a
 * postcode row's stored site is walked for its registration number. Upgrades
 * only, and every statutory number the pages state is recorded. No I/O.
 */

import type { DiscoveryOutcome } from './discover';
import {
  type DiscoveryDeps,
  type DiscoveryRow,
  settleCandidates,
} from './discover-sweep';
import { dedupeStated, type StatedOnSite } from './stated-numbers';

/** The walk rows are brought up to: walk g behind the crowded-host guard. */
export const CURRENT_WALK_VERSION = 1;

/** Unreadable re-walks before a row keeps its old answer for this version. */
export const MAX_WALK_ATTEMPTS = 3;

export type RewalkRow = {
  companyNumber: string;
  /** Companies House name, which a postcode match must find on the site. */
  companyName: string;
  postcode: string | null;
  evidence: 'none' | 'postcode_on_page';
  /** The stored site; null on a `none` row. */
  url: string | null;
  /** Banked search results, in rank order. */
  candidates: string[];
  /** Unreadable re-walks this row has already had at this version. */
  walkAttempts: number;
};

export type RewalkDeps = Pick<
  DiscoveryDeps,
  'crowdedHosts' | 'probe' | 'walkDisclosure' | 'sleep' | 'log'
> & {
  selectRows(maxRows: number): Promise<RewalkRow[]>;
  /** Write an upgrade; false when the row changed after it was read. */
  upgrade(row: RewalkRow, outcome: DiscoveryOutcome): Promise<boolean>;
  /** Stamp a row read with nothing to upgrade. */
  markWalked(row: RewalkRow): Promise<void>;
  /** Count a re-walk that could not read the row, leaving its answer alone. */
  markUnreadable(row: RewalkRow): Promise<void>;
  recordStated(entries: StatedOnSite[]): Promise<void>;
};

export type RewalkConfig = {
  maxRows: number;
  delayMs: number;
  dryRun: boolean;
};

export type RewalkSummary = {
  selected: number;
  processed: number;
  noneToNumber: number;
  noneToPostcode: number;
  postcodeToNumber: number;
  /** Read, with nothing to upgrade. */
  unchanged: number;
  unreadable: number;
  /** Rows on their first attempt, and how many of those could not be read. */
  firstAttempts: number;
  firstAttemptsUnreadable: number;
  /** Upgrades the database refused: the row changed after it was read. */
  unpersisted: number;
  errored: number;
  candidateFetches: number;
  /** Statutory numbers recorded (or, in a dry run, that would be). */
  statedNumbers: number;
};

/** First-attempt rows a run must reach before its read rate means anything. */
const MIN_GATE_ROWS = 25;

/**
 * Whether a run read so little that its network, not the sites, has failed.
 * Judged on first attempts only: the backlog's tail is dead-site retries.
 */
export function lostNetwork(summary: RewalkSummary): boolean {
  return (
    summary.firstAttempts >= MIN_GATE_ROWS &&
    summary.firstAttemptsUnreadable / summary.firstAttempts > 0.8
  );
}

/** Heartbeat interval. Counts only, never a company or a URL. */
const HEARTBEAT_ROWS = 25;

const NOTHING: DiscoveryOutcome = {
  url: null,
  evidenceUrl: null,
  evidence: 'none',
  rank: null,
};

/** The probe and walk read a row by these fields alone. */
function asDiscoveryRow(row: RewalkRow): DiscoveryRow {
  return {
    companyNumber: row.companyNumber,
    companyName: row.companyName,
    town: '',
    postcode: row.postcode,
    bankedCandidates: row.candidates,
  };
}

/** A postcode row's stored site, walked for the registration number; null when unreadable. */
async function walkStoredSite(
  row: RewalkRow,
  deps: RewalkDeps,
): Promise<{
  outcome: DiscoveryOutcome | null;
  stated: StatedOnSite[];
  fetches: number;
}> {
  if (!row.url) return { outcome: NOTHING, stated: [], fetches: 0 };
  const view = asDiscoveryRow(row);
  const probe = await deps.probe(view, row.url);
  if (!probe) return { outcome: null, stated: [], fetches: 1 };
  // Now a directory or a holding page: the sweep's to judge, not an upgrade.
  if (probe.onAggregator || probe.parked) {
    return { outcome: NOTHING, stated: probe.stated ?? [], fetches: 1 };
  }
  const walked = probe.crnFound
    ? probe
    : ((await deps.walkDisclosure(view, probe)) ?? probe);
  const stated = walked.stated ?? probe.stated ?? [];
  if (!walked.crnFound) return { outcome: NOTHING, stated, fetches: 1 };
  return {
    // The stored URL itself: a postcode row is never moved to another site.
    outcome: {
      url: row.url,
      evidenceUrl: walked.evidenceUrl,
      evidence: 'crn_on_page',
      rank: null,
    },
    stated,
    fetches: 1,
  };
}

/** Re-walk a slice of settled rows, upgrading where the new walk proves more. */
export async function rewalkWebsites(
  config: RewalkConfig,
  deps: RewalkDeps,
): Promise<RewalkSummary> {
  const rows = await deps.selectRows(config.maxRows);
  const summary: RewalkSummary = {
    selected: rows.length,
    processed: 0,
    noneToNumber: 0,
    noneToPostcode: 0,
    postcodeToNumber: 0,
    unchanged: 0,
    unreadable: 0,
    firstAttempts: 0,
    firstAttemptsUnreadable: 0,
    unpersisted: 0,
    errored: 0,
    candidateFetches: 0,
    statedNumbers: 0,
  };

  for (const [index, row] of rows.entries()) {
    if (index > 0) await deps.sleep(config.delayMs);
    summary.processed += 1;
    const firstAttempt = row.walkAttempts === 0;
    if (firstAttempt) summary.firstAttempts += 1;
    if (summary.processed % HEARTBEAT_ROWS === 0) {
      deps.log(
        `  ${summary.processed}/${rows.length} — ${summary.noneToNumber + summary.postcodeToNumber} by number, ${summary.noneToPostcode} by postcode`,
      );
    }
    try {
      const settled =
        row.evidence === 'none'
          ? await settleCandidates(
              asDiscoveryRow(row),
              row.candidates,
              deps,
              config.delayMs,
            )
          : await walkStoredSite(row, deps);
      summary.candidateFetches += settled.fetches;
      const stated = dedupeStated(settled.stated);
      summary.statedNumbers += stated.length;
      if (!config.dryRun && stated.length > 0) {
        await deps.recordStated(stated);
      }

      const outcome = settled.outcome;
      if (!outcome) {
        summary.unreadable += 1;
        if (firstAttempt) summary.firstAttemptsUnreadable += 1;
        if (!config.dryRun) await deps.markUnreadable(row);
        continue;
      }
      if (outcome.evidence === 'none' || !outcome.url) {
        summary.unchanged += 1;
        if (!config.dryRun) await deps.markWalked(row);
        continue;
      }

      // A refused write is not an upgrade; a dry run counts what it would write.
      if (!config.dryRun && !(await deps.upgrade(row, outcome))) {
        summary.unpersisted += 1;
        continue;
      }
      if (row.evidence === 'none') {
        if (outcome.evidence === 'crn_on_page') summary.noneToNumber += 1;
        else summary.noneToPostcode += 1;
      } else {
        summary.postcodeToNumber += 1;
      }
    } catch (error) {
      // Reason only, never the company or the URL.
      summary.errored += 1;
      deps.log(
        `  row failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      // Spend an attempt, so a row that always throws cannot lead every slice;
      // best effort, as a database outage is already counted above.
      if (!config.dryRun) await deps.markUnreadable(row).catch(() => {});
    }
  }
  return summary;
}
