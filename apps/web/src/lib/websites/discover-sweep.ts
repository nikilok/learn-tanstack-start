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
  /** Results a previous pass already paid for and never got to settle. Set
   *  only on a retry, and reusing them is what stops a second charge. */
  bankedCandidates: string[] | null;
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
  /** Note that a pass took this row and could not settle it. */
  markAttempt(companyNumber: string): Promise<void>;
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
  /** Rows the run actually reached. Lower than `selected` whenever the loop
   *  broke early, and the only honest denominator for an error rate. */
  processed: number;
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
  /** Rows resumed from banked candidates, costing no further credit. */
  retried: number;
  /** Rows left undecided because no candidate could be fetched at all. Their
   *  banked results survive, so the next slice retries them for free. */
  unreadable: number;
  written: number;
  errored: number;
  /** Searches that were charged but whose results could not be persisted. */
  creditsLost: number;
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
    processed: 0,
    searched: 0,
    foundByNumber: 0,
    foundByAddress: 0,
    foundNothing: 0,
    candidateFetches: 0,
    unsearchable: 0,
    retried: 0,
    unreadable: 0,
    written: 0,
    errored: 0,
    creditsLost: 0,
    stoppedEarly: false,
  };

  let failureStreak = 0;

  for (const [index, row] of rows.entries()) {
    if (index > 0) await deps.sleep(config.delayMs);

    if (summary.searched >= config.maxSearches) {
      summary.stoppedEarly = 'budget';
      break;
    }

    summary.processed += 1;

    try {
      // A row carrying banked candidates is a retry: the credit was spent on
      // a pass that failed before it could write an answer, and searching
      // again would charge twice for results we already hold.
      let urls = row.bankedCandidates;
      if (urls) {
        summary.retried += 1;
      } else {
        const query = buildQuery(row.companyName, row.town);
        if (!query) {
          // An empty query would spend a credit and match the whole web.
          summary.unsearchable += 1;
          continue;
        }

        const result = await deps.search(query);
        if (!result.ok) {
          // Counted only when charged. A request that never reached Serper, or
          // one it rejected without billing, is not a credit — and this
          // counter is both the budget and the `credits_spent` figure an
          // operator reconciles against the invoice.
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
        summary.searched += 1;
        urls = result.urls;

        // Bank BEFORE verifying. The credit is spent the moment the results
        // arrive, so a run that dies mid-fetch must not make the next one pay
        // for the same company again — and the row it creates comes back round
        // on a later slice because the selector admits undecided rows.
        // A throw here is the one failure that costs real money with nothing
        // to show for it: the credit is spent the instant the results arrive,
        // and without the row the next run pays for the same company again.
        // Worth a second attempt before writing it off, and worth saying out
        // loud when even that fails — a silently lost credit is invisible in
        // every counter the summary prints.
        if (!config.dryRun) {
          try {
            await deps.bankCandidates(row.companyNumber, urls);
          } catch {
            try {
              await deps.bankCandidates(row.companyNumber, urls);
            } catch (error) {
              summary.creditsLost += 1;
              deps.log(
                `  banking failed, credit lost: ${error instanceof Error ? error.name : 'unknown'}`,
              );
            }
          }
        }
      }

      const probes: CandidateProbe[] = [];
      let unreadable = 0;
      for (const url of urls.slice(0, MAX_CANDIDATES)) {
        const probe = await deps.probe(row, url);
        summary.candidateFetches += 1;
        if (probe) {
          probes.push(probe);
          // The registration number is the company identifying itself, and
          // nothing below it can beat that — so stop paying for fetches.
          if (probe.crnFound && !probe.onAggregator && !probe.parked) break;
        } else {
          unreadable += 1;
        }
        // Paced on EVERY candidate, including the ones that failed. `continue`
        // used to skip this on the commonest outcome, so five dead hosts became
        // roughly twenty requests back to back — each probe expands to host and
        // scheme variants, each preceded by a robots.txt fetch — from a bot
        // that advertises itself by name.
        await deps.sleep(config.delayMs);
      }

      // "We fetched the candidates and none of them proved anything" is an
      // answer. "We could not fetch any of them" is not, and writing it as one
      // records a permanent `none` that no selector can revisit: the sweep
      // requires url IS NOT NULL and this job's selector only readmits
      // `pending`. One flaky slice would otherwise write off every company in
      // it, credit already spent, on a DNS wobble. This is the graceful sibling
      // of the throw path — and the far commoner one.
      if (urls.length > 0 && probes.length === 0 && unreadable > 0) {
        summary.unreadable += 1;
        if (!config.dryRun) await deps.markAttempt(row.companyNumber);
        continue;
      }

      const outcome = decideFromCandidates(probes);
      if (outcome.evidence === 'crn_on_page') summary.foundByNumber += 1;
      else if (outcome.evidence === 'postcode_on_page') {
        summary.foundByAddress += 1;
      } else summary.foundNothing += 1;

      if (!config.dryRun && (await deps.write(row, outcome))) {
        summary.written += 1;
      }
    } catch (error) {
      // Reason only, never the company or the URL. A silent catch let a run
      // where every database call failed spend its whole budget nightly behind
      // a green tick, and the operator's only clue was a counter nobody was
      // watching.
      summary.errored += 1;
      deps.log(
        `  row failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }

    if ((index + 1) % HEARTBEAT_ROWS === 0) {
      deps.log(
        `  ${index + 1}/${rows.length} — ${summary.foundByNumber + summary.foundByAddress} found, ${summary.searched} searched`,
      );
    }
  }

  return summary;
}
