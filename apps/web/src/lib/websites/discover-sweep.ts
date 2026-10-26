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

import { hostNamer } from './company-naming';
import { needsRender } from './disclosure-walk';
import type { CandidateProbe, DiscoveryOutcome } from './discover';
import {
  buildQuery,
  decideFromCandidates,
  MAX_CANDIDATES,
  siteOrigins,
} from './discover';
import { judgeSite } from './name-and-place';
import type { Officer, OfficerLookup } from './officer-names';
import type { StatedOnSite } from './stated-numbers';

export type DiscoveryRow = {
  companyNumber: string;
  companyName: string;
  /** Sponsor-register entries for the company, which a site may name it by. */
  sponsorNames: string[];
  town: string;
  postcode: string | null;
  /** Towns the sponsor register lists the company at. */
  registerTowns: string[];
  /** The registered office locality. */
  locality: string | null;
  /** Results a previous pass already paid for and never got to settle. Set
   *  only on a retry, and reusing them is what stops a second charge. */
  bankedCandidates: string[] | null;
};

/** Mirrors the client's union so a renamed reason is a type error, not a
 *  comparison that silently stops matching. */
export type SearchFailure =
  | 'auth'
  | 'rate_limit'
  | 'out_of_credits'
  | 'malformed'
  | 'http'
  | 'network';

export type SearchResult =
  | { ok: true; urls: string[] }
  | { ok: false; reason: SearchFailure; charged?: boolean };

export type DiscoveryDeps = {
  selectRows(maxRows: number): Promise<DiscoveryRow[]>;
  /** Hosts banked results name for too many companies (crowdKey form). */
  crowdedHosts: ReadonlySet<string>;
  search(query: string): Promise<SearchResult>;
  /** Persist the raw result URLs the moment they arrive. */
  bankCandidates(companyNumber: string, urls: string[]): Promise<void>;
  /** Fetch one candidate ORIGIN and read the two query-independent signals. */
  probe(row: DiscoveryRow, url: string): Promise<CandidateProbe | null>;
  /** Probe the disclosure paths of an already-fetched candidate, returning it
   *  updated with anything they proved. */
  walkDisclosure(
    row: DiscoveryRow,
    probe: CandidateProbe,
  ): Promise<CandidateProbe | null>;
  /** The company's officers, resigned ones included, or why they could not be read. */
  officers(companyNumber: string): Promise<OfficerLookup>;
  /** Read a silent candidate again in a browser, homepage and walk; null when it would not render. Absent, nothing is rendered. */
  render?(
    row: DiscoveryRow,
    probe: CandidateProbe,
  ): Promise<CandidateProbe | null>;
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
  /** Companies the two-signal rule found a site for. */
  foundByNameAndPlace: number;
  /** Searched, fetched, and confirmed by none of them. */
  foundNothing: number;
  candidateFetches: number;
  /** Companies House officer lookups, and how many failed. */
  officerLookups: number;
  officerFailures: number;
  /** Candidates read again in a browser, and companies found from what one showed. */
  rendered: number;
  foundByRender: number;
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
  /** Decisions the database refused to store, the row having changed hands. */
  unpersisted: number;
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

/** What reading one company's candidates came to. */
export type Settled = {
  /** Null when no site, or no officer list it needed, could be read: not an answer, so nothing is written. */
  outcome: DiscoveryOutcome | null;
  /** Candidate homepages requested. */
  fetches: number;
  /** Statutory numbers the pages read stated. */
  stated: StatedOnSite[];
  /** Whether the company's officers were asked for, and why they could not be read. */
  officers: 'unasked' | 'read' | 'failed' | 'stopped';
  /** Candidates read again in a browser, and whether the outcome came from one. */
  rendered: number;
  byRender: boolean;
};

/** One of the top candidates in rank order: its homepage probe, null when it could not be read. */
type Slot = { url: string; probe: CandidateProbe | null; walked: boolean };

/** A candidate that is a site at all: not a directory, not a holding page. */
function usable(probe: CandidateProbe): boolean {
  return !probe.onAggregator && !probe.parked;
}

/** A URL's host, or '' when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The fetching half of discovery for one company: probe, decide, walk, decide, then the two-signal rule. */
export async function settleCandidates(
  row: DiscoveryRow,
  urls: readonly string[],
  deps: Pick<
    DiscoveryDeps,
    | 'crowdedHosts'
    | 'probe'
    | 'walkDisclosure'
    | 'officers'
    | 'render'
    | 'sleep'
  >,
  delayMs: number,
): Promise<Settled> {
  // Origins, not raw results: several results usually share one site, so
  // this removes fetches rather than adding them. Directories, listed or
  // crowded, are dropped before they can take one of the slots.
  const origins = siteOrigins(urls, deps.crowdedHosts);
  const slots: Slot[] = [];
  let unreadable = 0;
  let fetches = 0;
  for (const url of origins.slice(0, MAX_CANDIDATES)) {
    const probe = await deps.probe(row, url);
    fetches += 1;
    slots.push({ url, probe, walked: false });
    if (probe) {
      // The registration number is the company identifying itself, and
      // nothing below it can beat that — so stop paying for fetches.
      if (probe.crnFound && usable(probe)) break;
    } else {
      unreadable += 1;
    }
    // Every candidate, including failures: skipping the commonest outcome
    // made five dead hosts ~20 unpaced requests.
    await deps.sleep(delayMs);
  }
  const probes = () =>
    slots.flatMap((slot) => (slot.probe ? [slot.probe] : []));
  let officers: Settled['officers'] = 'unasked';
  let rendered = 0;
  const settled = (
    outcome: DiscoveryOutcome | null,
    byRender = false,
  ): Settled => ({
    outcome,
    fetches,
    stated: probes().flatMap((p) => p.stated ?? []),
    officers,
    rendered,
    byRender,
  });

  // Read-and-found-nothing is an answer; could-not-read is not, and storing
  // it as one writes a permanent `none` no selector revisits. A directory
  // that loaded is not the company's site loading; a parked page is.
  const siteLoaded = probes().some((p) => !p.onAggregator);
  if (origins.length > 0 && !siteLoaded && unreadable > 0) {
    return settled(null);
  }

  /** Walk a candidate's pages, once, keeping what they read. */
  const walk = async (slot: Slot, probe: CandidateProbe) => {
    slot.walked = true;
    slot.probe = (await deps.walkDisclosure(row, probe)) ?? probe;
  };

  let outcome = decideFromCandidates(probes());

  // Homepages settled nothing, so walk the legal pages of the top-ranked
  // usable candidate. Measured over 20 companies: this tripled publishable
  // rows. The same pure decider runs again over the updated probe, so there
  // is still one place a decision is made.
  if (outcome.evidence !== 'crn_on_page') {
    const top = slots.find((slot) => slot.probe && usable(slot.probe));
    if (top?.probe) {
      await walk(top, top.probe);
      outcome = decideFromCandidates(probes());
    }
  }
  if (outcome.evidence !== 'none') return settled(outcome);

  // The two-signal rule, down the candidates in rank order as it was sealed.
  const named = hostNamer(row);
  let found: Officer[] | null | undefined;
  for (const slot of slots) {
    const { probe } = slot;
    if (probe && !usable(probe)) continue;
    // A site naming the company that refused us may be its own: no pick past it.
    if ((!probe || probe.challenged) && named(hostOf(slot.url))) break;
    if (!probe) continue;
    if (!slot.walked) {
      await walk(slot, probe);
      outcome = decideFromCandidates(probes());
      // A number or named postcode on its pages: the existing proofs own the row.
      if (outcome.evidence !== 'none') return settled(outcome);
    }
    const site = slot.probe ?? probe;
    // Raw pages that show the walk nothing are read again in a browser, before the people lookup.
    let seen: CandidateProbe | null = null;
    if (deps.render && needsRender(site)) {
      rendered += 1;
      const shown = await deps.render(row, site);
      if (shown) {
        // What the raw pages stated stays on record beside what the rendered ones did.
        slot.probe = {
          ...shown,
          stated: [...(site.stated ?? []), ...(shown.stated ?? [])],
        };
        outcome = decideFromCandidates(probes());
        if (outcome.evidence !== 'none') return settled(outcome, true);
        // A render that landed on a directory or a holding page proves nothing.
        if (usable(shown)) seen = slot.probe;
      }
    }
    // The rule on the raw pages, as it was measured, then on the rendered ones.
    for (const read of seen ? [site, seen] : [site]) {
      const pages = { url: read.url, pages: read.pages ?? [] };
      let verdict = judgeSite(row, pages);
      if (verdict.kind === 'needs_officers') {
        if (found === undefined) {
          const answer = await deps.officers(row.companyNumber);
          found = Array.isArray(answer) ? answer : null;
          officers = Array.isArray(answer) ? 'read' : answer;
        }
        if (!found) return settled(null);
        verdict = judgeSite(
          row,
          pages,
          found.filter((officer) => officer.current),
        );
      }
      if (verdict.kind === 'proved') {
        return settled(
          {
            url: read.url,
            evidenceUrl: verdict.evidenceUrl,
            evidence: 'name_and_place',
            rank: probes().indexOf(slot.probe ?? read) + 1,
          },
          read === seen,
        );
      }
    }
  }
  return settled(outcome);
}

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
    foundByNameAndPlace: 0,
    foundNothing: 0,
    candidateFetches: 0,
    officerLookups: 0,
    officerFailures: 0,
    rendered: 0,
    foundByRender: 0,
    unsearchable: 0,
    retried: 0,
    unreadable: 0,
    written: 0,
    errored: 0,
    creditsLost: 0,
    unpersisted: 0,
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
    // Rows reached, emitted before the `continue`s that used to skip it.
    if (summary.processed % HEARTBEAT_ROWS === 0) {
      deps.log(
        `  ${summary.processed}/${rows.length} — ${summary.foundByNumber + summary.foundByAddress + summary.foundByNameAndPlace} found, ${summary.searched} searched`,
      );
    }

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
          // Counted only when charged: this is the credits_spent figure.
          if (result.reason === 'out_of_credits') {
            summary.stoppedEarly = 'out_of_credits';
            break;
          }
          // A malformed 200 was still billed, so it belongs in credits_spent
          // even though it produced nothing usable.
          if (result.charged) summary.searched += 1;
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
        // The credit is spent the instant results arrive, so a failed bank is
        // money gone. Retry, then say so.
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

      const settled = await settleCandidates(row, urls, deps, config.delayMs);
      summary.candidateFetches += settled.fetches;
      summary.rendered += settled.rendered;
      if (settled.byRender) summary.foundByRender += 1;
      if (settled.officers === 'read' || settled.officers === 'failed') {
        summary.officerLookups += 1;
      }
      if (settled.officers === 'failed' || settled.officers === 'stopped') {
        summary.officerFailures += 1;
      }
      if (!settled.outcome) {
        summary.unreadable += 1;
        // A run that had stopped asking for officers spends no attempt: the row comes back next run.
        if (!config.dryRun && settled.officers !== 'stopped') {
          await deps.markAttempt(row.companyNumber);
        }
        continue;
      }
      const outcome = settled.outcome;
      if (outcome.evidence === 'crn_on_page') summary.foundByNumber += 1;
      else if (outcome.evidence === 'postcode_on_page') {
        summary.foundByAddress += 1;
      } else if (outcome.evidence === 'name_and_place') {
        summary.foundByNameAndPlace += 1;
      } else summary.foundNothing += 1;

      if (!config.dryRun) {
        // `false` = another discoverer claimed the row. Charged, decided, lost.
        if (await deps.write(row, outcome)) summary.written += 1;
        else summary.unpersisted += 1;
      }
    } catch (error) {
      // Reason only, never the company or the URL.
      summary.errored += 1;
      deps.log(
        `  row failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  return summary;
}
