/**
 * Orchestrator for search-based website discovery. All I/O is injected, so the
 * decisions here are testable without a network, a database or a credit.
 *
 * Mirrors sweepWebsites deliberately: same shape, same bounded-slice contract,
 * same refusal to log anything identifying. What it does NOT do is verify
 * liveness — it writes rows with `checked_at` left NULL, exactly as the
 * registry importer does, so the nightly sweep remains the single thing that
 * decides whether a URL renders. Two jobs claiming that would be two jobs to
 * keep in agreement.
 */

import type { CandidateProbe, DiscoveryOutcome } from './discover';
import { buildQuery, decideFromCandidates, MAX_CANDIDATES } from './discover';

export type DiscoveryRow = {
  companyNumber: string;
  companyName: string;
  town: string;
  postcode: string | null;
};

export type SearchResult =
  | { ok: true; urls: string[] }
  | { ok: false; reason: string };

export type DiscoveryDeps = {
  selectRows(maxRows: number): Promise<DiscoveryRow[]>;
  search(query: string): Promise<SearchResult>;
  /** Persist the raw result URLs the moment they arrive. */
  bankCandidates(companyNumber: string, urls: string[]): Promise<void>;
  /** Fetch one candidate and read the two query-independent signals off it. */
  probe(row: DiscoveryRow, url: string): Promise<CandidateProbe | null>;
  write(row: DiscoveryRow, outcome: DiscoveryOutcome): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
};

export type DiscoveryConfig = {
  maxRows: number;
  /** Hard ceiling on searches, so a runaway run cannot drain the balance. */
  maxSearches: number;
  delayMs: number;
  dryRun: boolean;
};

export type DiscoverySummary = {
  selected: number;
  searched: number;
  /** Companies where a candidate carried the registration number. */
  foundByNumber: number;
  /** Companies where a candidate carried the registered office postcode. */
  foundByAddress: number;
  /** Searched, fetched, and confirmed by neither. */
  foundNothing: number;
  candidateFetches: number;
  /** Names too thin to search — the credit was never spent. */
  unsearchable: number;
  written: number;
  errored: number;
  /** Set when the run stopped early: no credits, or the search budget hit. */
  stoppedEarly: false | 'out_of_credits' | 'budget' | 'search_failing';
};

/**
 * Consecutive failed searches before the run stops.
 *
 * A wrong key, a network block or a provider outage fails every query, and
 * each one is a wasted slice of the nightly window. Distinct from the sweep's
 * breaker because the failure is upstream of any company: nothing about the
 * data can fix it.
 */
export const SEARCH_FAILURE_STREAK = 10;

/** Heartbeat interval. Counts only — never a company or a URL. */
const HEARTBEAT_ROWS = 25;

export async function discoverWebsites(
  config: DiscoveryConfig,
  deps: DiscoveryDeps,
): Promise<DiscoverySummary> {
  const rows = await deps.selectRows(config.maxRows);
  const summary: DiscoverySummary = {
    selected: rows.length,
    searched: 0,
    foundByNumber: 0,
    foundByAddress: 0,
    foundNothing: 0,
    candidateFetches: 0,
    unsearchable: 0,
    written: 0,
    errored: 0,
    stoppedEarly: false,
  };

  let failureStreak = 0;

  for (const [index, row] of rows.entries()) {
    if (index > 0) await deps.sleep(config.delayMs);

    if (summary.searched >= config.maxSearches) {
      summary.stoppedEarly = 'budget';
      break;
    }

    try {
      const query = buildQuery(row.companyName, row.town);
      if (!query) {
        // An empty query would spend a credit and match the whole web.
        summary.unsearchable += 1;
        continue;
      }

      const result = await deps.search(query);
      summary.searched += 1;
      if (!result.ok) {
        if (result.reason === 'out_of_credits') {
          summary.stoppedEarly = 'out_of_credits';
          break;
        }
        failureStreak += 1;
        if (failureStreak >= SEARCH_FAILURE_STREAK) {
          summary.stoppedEarly = 'search_failing';
          break;
        }
        summary.errored += 1;
        continue;
      }
      failureStreak = 0;

      // Bank BEFORE verifying. The credit is spent the moment the results
      // arrive, so a run that dies mid-fetch must not make the next one pay
      // for the same company again.
      if (!config.dryRun) {
        await deps.bankCandidates(row.companyNumber, result.urls);
      }

      const probes: CandidateProbe[] = [];
      for (const url of result.urls.slice(0, MAX_CANDIDATES)) {
        const probe = await deps.probe(row, url);
        summary.candidateFetches += 1;
        if (!probe) continue;
        probes.push(probe);
        // The registration number is the company identifying itself, and
        // nothing below it can beat that — so stop paying for fetches.
        if (probe.crnFound && !probe.onAggregator && !probe.parked) break;
        await deps.sleep(config.delayMs);
      }

      const outcome = decideFromCandidates(probes);
      if (outcome.evidence === 'crn_on_page') summary.foundByNumber += 1;
      else if (outcome.evidence === 'postcode_on_page') {
        summary.foundByAddress += 1;
      } else summary.foundNothing += 1;

      if (!config.dryRun && (await deps.write(row, outcome))) {
        summary.written += 1;
      }
    } catch {
      summary.errored += 1;
    }

    if ((index + 1) % HEARTBEAT_ROWS === 0) {
      deps.log(
        `  ${index + 1}/${rows.length} — ${summary.foundByNumber + summary.foundByAddress} found, ${summary.searched} searched`,
      );
    }
  }

  return summary;
}
