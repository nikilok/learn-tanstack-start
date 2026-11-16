/**
 * Re-walking rows that are already settled, at zero search credits: a `none`
 * row's banked results go through discovery's own settle step, a postcode
 * row's stored site is walked for its registration number, and a registry
 * row's for the number or what confirms the register. Upgrades only, and
 * every statutory number the pages state is recorded. No I/O.
 */

import type { DiscoveryOutcome } from './discover';
import {
  type DiscoveryDeps,
  type DiscoveryRow,
  type Settled,
  settleCandidates,
} from './discover-sweep';
import { judgeSite } from './name-and-place';
import { dedupeStated, type StatedOnSite } from './stated-numbers';

/** The walk rows are brought up to: walk 3 reads every fixed path and about links, and walks each candidate the two-signal rule reaches. */
export const CURRENT_WALK_VERSION = 3;

/** Unreadable re-walks before a row keeps its old answer for this version. */
export const MAX_WALK_ATTEMPTS = 3;

export type RewalkRow = {
  companyNumber: string;
  /** Companies House name, which a postcode match must find on the site. */
  companyName: string;
  /** Sponsor-register entries, which a postcode match may find instead. */
  sponsorNames: string[];
  postcode: string | null;
  /** Towns the sponsor register lists the company at. */
  registerTowns: string[];
  /** The registered office locality. */
  locality: string | null;
  evidence: 'none' | 'postcode_on_page' | 'registry';
  /** Which discoverer wrote the row. */
  source: string;
  /** The stored site; null on a `none` row. */
  url: string | null;
  /** Banked search results, in rank order. */
  candidates: string[];
  /** Unreadable re-walks this row has already had at this version. */
  walkAttempts: number;
};

export type RewalkDeps = Pick<
  DiscoveryDeps,
  | 'crowdedHosts'
  | 'probe'
  | 'walkDisclosure'
  | 'officers'
  | 'render'
  | 'sleep'
  | 'log'
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
  noneToNameAndPlace: number;
  postcodeToNumber: number;
  /** Registry rows that gained their number, and those a page confirmed. */
  registryToNumber: number;
  registryConfirmed: number;
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
  /** Companies House officer lookups, and how many failed. */
  officerLookups: number;
  officerFailures: number;
  /** Candidates read again in a browser, and rows upgraded from what one showed. */
  rendered: number;
  upgradedByRender: number;
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
    sponsorNames: row.sponsorNames,
    town: '',
    postcode: row.postcode,
    registerTowns: row.registerTowns,
    locality: row.locality,
    bankedCandidates: row.candidates,
  };
}

/** A postcode row's stored site, walked for the registration number; null when unreadable. */
async function walkStoredSite(
  row: RewalkRow,
  deps: RewalkDeps,
): Promise<Settled> {
  /** What the walk came to: no officers asked and nothing rendered for a postcode row. */
  const settled = (
    outcome: DiscoveryOutcome | null,
    stated: StatedOnSite[],
    fetches: number,
  ): Settled => ({
    outcome,
    stated,
    fetches,
    officers: 'unasked',
    rendered: 0,
    byRender: false,
  });
  if (!row.url) return settled(NOTHING, [], 0);
  const view = asDiscoveryRow(row);
  const probe = await deps.probe(view, row.url);
  if (!probe) return settled(null, [], 1);
  // Now a directory or a holding page: the sweep's to judge, not an upgrade.
  if (probe.onAggregator || probe.parked) {
    return settled(NOTHING, probe.stated ?? [], 1);
  }
  const walked = probe.crnFound
    ? probe
    : ((await deps.walkDisclosure(view, probe)) ?? probe);
  const stated = walked.stated ?? probe.stated ?? [];
  if (!walked.crnFound) return settled(NOTHING, stated, 1);
  // The stored URL itself: a postcode row is never moved to another site.
  return settled(
    {
      url: row.url,
      evidenceUrl: walked.evidenceUrl,
      evidence: 'crn_on_page',
      rank: null,
    },
    stated,
    1,
  );
}

/** A registry row's stored site, walked for the number, then for what confirms the register: the registered postcode on a page naming the company in full, or the two-signal rule on the site as served. Null when unreadable. */
async function walkRegistrySite(
  row: RewalkRow,
  deps: RewalkDeps,
): Promise<Settled> {
  let officers: Settled['officers'] = 'unasked';
  let stated: StatedOnSite[] = [];
  let fetches = 0;
  const settled = (outcome: DiscoveryOutcome | null): Settled => ({
    outcome,
    stated,
    fetches,
    officers,
    rendered: 0,
    byRender: false,
  });
  /** The stored URL itself: a registry row is never moved to another site. */
  const proved = (
    evidence: 'crn_on_page' | 'registry_confirmed',
    evidenceUrl: string | null,
  ): Settled => settled({ url: row.url, evidenceUrl, evidence, rank: null });
  if (!row.url) return settled(NOTHING);
  const view = asDiscoveryRow(row);
  const probe = await deps.probe(view, row.url);
  fetches = 1;
  // A bot challenge is not the site read.
  if (!probe || probe.challenged) return settled(null);
  stated = probe.stated ?? [];
  // Now a directory or a holding page: the sweep's to judge, not an upgrade.
  if (probe.onAggregator || probe.parked) return settled(NOTHING);
  const walked = probe.crnFound
    ? probe
    : ((await deps.walkDisclosure(view, probe)) ?? probe);
  stated = walked.stated ?? stated;
  if (walked.crnFound) return proved('crn_on_page', walked.evidenceUrl);
  if (walked.namedInFullAt) {
    return proved('registry_confirmed', walked.namedInFullAt);
  }
  const pages = walked.pages ?? [];
  // Judged on the host that served the homepage: a stored URL may redirect.
  const site = { url: pages[0]?.url ?? row.url, pages };
  let verdict = judgeSite(row, site);
  if (verdict.kind === 'needs_officers') {
    const answer = await deps.officers(row.companyNumber);
    officers = Array.isArray(answer) ? 'read' : answer;
    if (!Array.isArray(answer)) return settled(null);
    verdict = judgeSite(
      row,
      site,
      answer.filter((officer) => officer.current),
    );
  }
  return verdict.kind === 'proved'
    ? proved('registry_confirmed', verdict.evidenceUrl)
    : settled(NOTHING);
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
    noneToNameAndPlace: 0,
    postcodeToNumber: 0,
    registryToNumber: 0,
    registryConfirmed: 0,
    unchanged: 0,
    unreadable: 0,
    firstAttempts: 0,
    firstAttemptsUnreadable: 0,
    unpersisted: 0,
    errored: 0,
    candidateFetches: 0,
    officerLookups: 0,
    officerFailures: 0,
    rendered: 0,
    upgradedByRender: 0,
    statedNumbers: 0,
  };

  for (const [index, row] of rows.entries()) {
    if (index > 0) await deps.sleep(config.delayMs);
    summary.processed += 1;
    const firstAttempt = row.walkAttempts === 0;
    if (firstAttempt) summary.firstAttempts += 1;
    if (summary.processed % HEARTBEAT_ROWS === 0) {
      deps.log(
        `  ${summary.processed}/${rows.length} — ${summary.noneToNumber + summary.postcodeToNumber + summary.registryToNumber} by number, ${summary.noneToPostcode} by postcode, ${summary.noneToNameAndPlace} by name and place, ${summary.registryConfirmed} registry confirmed`,
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
          : row.evidence === 'registry'
            ? await walkRegistrySite(row, deps)
            : await walkStoredSite(row, deps);
      summary.candidateFetches += settled.fetches;
      summary.rendered += settled.rendered;
      if (settled.officers === 'read' || settled.officers === 'failed') {
        summary.officerLookups += 1;
      }
      if (settled.officers === 'failed' || settled.officers === 'stopped') {
        summary.officerFailures += 1;
      }
      const stated = dedupeStated(settled.stated);
      summary.statedNumbers += stated.length;
      if (!config.dryRun && stated.length > 0) {
        await deps.recordStated(stated);
      }

      const outcome = settled.outcome;
      // A run that had stopped asking for officers leaves the row as it was, for the next run.
      if (!outcome && settled.officers === 'stopped') continue;
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
      if (settled.byRender) summary.upgradedByRender += 1;
      if (row.evidence === 'none') {
        if (outcome.evidence === 'crn_on_page') summary.noneToNumber += 1;
        else if (outcome.evidence === 'name_and_place') {
          summary.noneToNameAndPlace += 1;
        } else summary.noneToPostcode += 1;
      } else if (row.evidence === 'registry') {
        if (outcome.evidence === 'crn_on_page') summary.registryToNumber += 1;
        else summary.registryConfirmed += 1;
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
