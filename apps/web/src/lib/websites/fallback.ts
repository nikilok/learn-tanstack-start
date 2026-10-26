/**
 * The fallback job: for a search row every proof has left empty, the
 * candidate homepage a site picker chooses. The picker is injected, and the
 * job keeps its choice only when the choice's own domain names the company and
 * its homepage is not a holding page. A kept choice lands as `assessed`,
 * waiting for the sweep like every other discovery. No I/O.
 *
 * A candidate whose homepage does not load is left out, as the rule was
 * measured. A row is settled once the picker has answered for it, with a
 * choice or without, and is never asked again: only an answer that could not
 * be read leaves it for the next pass.
 */

import { hostNamer } from './company-naming';
import { MAX_CANDIDATES, siteOrigins } from './discover';
import { visibleText } from './extract';
import { PAGE_TEXT_CHARS } from './name-and-place';
import { normaliseWebsiteUrl, siteOf } from './normalise-url';
import { looksParked, looksPlaceholder } from './page-signals';
import { ukSection } from './uk-section';

/** A row the fallback reads: the register's facts and the banked search results. */
export type FallbackRow = {
  companyNumber: string;
  /** Companies House name. */
  companyName: string;
  /** Sponsor-register entries, trading names included. */
  sponsorNames: string[];
  /** Towns the sponsor register lists the company at. */
  registerTowns: string[];
  locality: string | null;
  postcode: string | null;
  /** Incorporation date, YYYY-MM-DD. */
  incorporated: string | null;
  /** What the company does, as its SIC codes' descriptions. */
  trades: string[];
  /** Banked search results, in rank order. */
  candidates: string[];
};

/** The register's facts as the picker reads them. */
export type PickerCompany = {
  number: string;
  name: string;
  sponsorNames: readonly string[];
  towns: readonly string[];
  locality: string | null;
  postcode: string | null;
  incorporated: string | null;
  trades: readonly string[];
};

/** One candidate homepage as read: its origin, title and visible text. */
export type PickerCandidate = { origin: string; title: string; text: string };

/** Why the picker answered as it did. */
export type PickerReason =
  | 'picked'
  | 'below_threshold'
  | 'no_candidates'
  | 'unavailable';

/** The picker's answer: the chosen candidate's origin or none, why, and the input tokens it was billed. */
export type PickerAnswer = {
  pick: string | null;
  reason: PickerReason;
  tokens: number;
};

/** Which candidate, if any, the picker would publish for the company. */
export type Picker = (
  company: PickerCompany,
  candidates: PickerCandidate[],
) => Promise<PickerAnswer>;

/** A fetched page, or that it could not be read. */
export type FallbackPage =
  | { ok: true; url: string; html: string }
  | { ok: false };

/** What the fallback writes for a kept choice. */
export type FallbackPick = {
  /** The canonical origin, as every writer of url stores one. */
  url: string;
  /** Its UK section, when it shows one that loads. */
  linkUrl: string | null;
};

export type FallbackDeps = {
  selectRows(maxRows: number): Promise<FallbackRow[]>;
  /** Hosts discovery treats as directories. */
  crowdedHosts: ReadonlySet<string>;
  /** Fetch a homepage, trying host and scheme variants. */
  fetchSite(url: string): Promise<FallbackPage>;
  /** Fetch one exact page. */
  fetchPage(url: string): Promise<FallbackPage>;
  pick: Picker;
  /** Write a kept choice and settle the row; false when the row changed after it was read. */
  writePick(row: FallbackRow, pick: FallbackPick): Promise<boolean>;
  /** Settle a row without a choice. */
  markSettled(row: FallbackRow): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
};

export type FallbackConfig = {
  maxRows: number;
  /** Pause before each fetch. */
  delayMs: number;
  /** Ask the picker and decide, writing nothing. */
  dryRun: boolean;
};

export type FallbackSummary = {
  selected: number;
  processed: number;
  /** Settled unasked: no candidate's domain names the company, so nothing could be kept. */
  noneNamed: number;
  /** Settled unasked: no candidate loaded with a page to read. */
  noneReadable: number;
  asked: number;
  /** Choices kept, and how many of those link to a UK section. */
  picked: number;
  ukSections: number;
  belowThreshold: number;
  /** Choices refused: the domain names no company of the row's, or the homepage is a holding page. */
  notNamed: number;
  holdingPage: number;
  /** Left for the next pass: the picker could not answer. */
  unavailable: number;
  /** Kept choices the database refused: the row changed after it was read. */
  unpersisted: number;
  errored: number;
  /** Homepages fetched, and how many of those did not load. */
  homepageFetches: number;
  homepageFailures: number;
  /** Input tokens billed. */
  tokens: number;
};

/** Fetches a run must make before its failure rate means anything. */
const MIN_GATE_FETCHES = 50;

/** Whether a run's homepages failed so widely that its network, not the sites, has failed. */
export function lostNetwork(summary: FallbackSummary): boolean {
  return (
    summary.homepageFetches >= MIN_GATE_FETCHES &&
    summary.homepageFailures / summary.homepageFetches > 0.8
  );
}

/** Heartbeat interval. Counts only, never a company or a URL. */
const HEARTBEAT_ROWS = 25;

/** Characters of a title read. */
const TITLE_CHARS = 300;
const TITLE = new RegExp(
  `<title[^>]*>([\\s\\S]{0,${TITLE_CHARS}}?)</title>`,
  'i',
);

/** A homepage as the picker reads it: its title and visible text, spaces collapsed, at most PAGE_TEXT_CHARS of text. */
export function readCandidate(origin: string, html: string): PickerCandidate {
  const title = TITLE.exec(html)?.[1] ?? '';
  return {
    origin,
    title: visibleText(title).replace(/\s+/g, ' ').trim(),
    text: visibleText(html)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PAGE_TEXT_CHARS),
  };
}

/** The row's facts as the picker reads them. */
export function pickerCompany(row: FallbackRow): PickerCompany {
  return {
    number: row.companyNumber,
    name: row.companyName,
    sponsorNames: row.sponsorNames,
    towns: row.registerTowns,
    locality: row.locality,
    postcode: row.postcode,
    incorporated: row.incorporated,
    trades: row.trades,
  };
}

/** A candidate read off its homepage, with the page it was read from and the url that served it. */
type ReadCandidate = PickerCandidate & {
  html: string;
  canonical: string;
  served: string;
};

/** What one row came to. */
type RowOutcome =
  | 'noneNamed'
  | 'noneReadable'
  | 'belowThreshold'
  | 'notNamed'
  | 'holdingPage'
  | 'unavailable'
  | 'picked'
  | 'unpersisted';

/** Outcomes that settle a row without a choice; the rest leave it for the next pass or write one. */
const SETTLES = new Set<RowOutcome>([
  'noneNamed',
  'noneReadable',
  'belowThreshold',
  'notNamed',
  'holdingPage',
]);

/** Read a row's candidates and ask the picker; the outcome, and the choice to write when there is one. */
async function decideRow(
  row: FallbackRow,
  config: FallbackConfig,
  deps: FallbackDeps,
  summary: FallbackSummary,
): Promise<{ outcome: RowOutcome; pick?: FallbackPick }> {
  const origins = siteOrigins(row.candidates, deps.crowdedHosts).slice(
    0,
    MAX_CANDIDATES,
  );
  const named = hostNamer(row);
  const namesCompany = (origin: string) => named(new URL(origin).hostname);
  // Only a candidate whose domain names the company can be kept.
  if (!origins.some(namesCompany)) return { outcome: 'noneNamed' };

  const read: ReadCandidate[] = [];
  for (const origin of origins) {
    const canonical = normaliseWebsiteUrl(origin);
    if (!canonical) continue;
    await deps.sleep(config.delayMs);
    summary.homepageFetches++;
    const page = await deps.fetchSite(canonical);
    if (!page.ok) {
      summary.homepageFailures++;
      continue;
    }
    const candidate = readCandidate(origin, page.html);
    if (looksParked(candidate.text)) continue;
    read.push({ ...candidate, html: page.html, canonical, served: page.url });
  }
  if (read.length === 0) return { outcome: 'noneReadable' };

  summary.asked++;
  const answer = await deps.pick(
    pickerCompany(row),
    read.map(({ origin, title, text }) => ({ origin, title, text })),
  );
  summary.tokens += answer.tokens;
  if (answer.reason === 'below_threshold') return { outcome: 'belowThreshold' };
  if (answer.reason !== 'picked') return { outcome: 'unavailable' };
  const chosen = read.find((candidate) => candidate.origin === answer.pick);
  if (!chosen) return { outcome: 'unavailable' };
  // The served host too: a named domain that redirects elsewhere serves another business's page.
  if (!namesCompany(chosen.origin) || !named(siteHost(chosen.served))) {
    return { outcome: 'notNamed' };
  }
  if (looksPlaceholder(chosen.text)) return { outcome: 'holdingPage' };

  const section = ukSection(chosen.canonical, chosen.html);
  let linkUrl: string | null = null;
  if (section) {
    await deps.sleep(config.delayMs);
    const page = await deps.fetchPage(section);
    // A section that does not load, lands on another site or is itself a holding page is no link.
    if (
      page.ok &&
      siteHost(page.url) === siteHost(chosen.canonical) &&
      !looksPlaceholder(visibleText(page.html))
    ) {
      linkUrl = section;
    }
  }
  return { outcome: 'picked', pick: { url: chosen.canonical, linkUrl } };
}

/** A url's host as a site is compared (siteOf); '' when it will not parse. */
function siteHost(url: string): string {
  try {
    return siteOf(new URL(url).hostname);
  } catch {
    return '';
  }
}

/** An error's text with the row's company number and candidate hosts taken out, as a public log may carry it. */
function redacted(err: unknown, row: FallbackRow): string {
  let text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  text = text.split(row.companyNumber).join('<company>');
  for (const url of row.candidates) {
    const host = siteHost(url);
    if (host) text = text.split(host).join('<host>');
  }
  return text;
}

/** Run one bounded slice of the fallback. */
export async function fallbackWebsites(
  config: FallbackConfig,
  deps: FallbackDeps,
): Promise<FallbackSummary> {
  const summary: FallbackSummary = {
    selected: 0,
    processed: 0,
    noneNamed: 0,
    noneReadable: 0,
    asked: 0,
    picked: 0,
    ukSections: 0,
    belowThreshold: 0,
    notNamed: 0,
    holdingPage: 0,
    unavailable: 0,
    unpersisted: 0,
    errored: 0,
    homepageFetches: 0,
    homepageFailures: 0,
    tokens: 0,
  };
  const rows = await deps.selectRows(config.maxRows);
  summary.selected = rows.length;

  for (const [index, row] of rows.entries()) {
    try {
      const decided = await decideRow(row, config, deps, summary);
      let outcome = decided.outcome;
      if (decided.pick && !config.dryRun) {
        const written = await deps.writePick(row, decided.pick);
        if (!written) outcome = 'unpersisted';
      }
      if (SETTLES.has(outcome) && !config.dryRun) await deps.markSettled(row);
      summary[outcome]++;
      if (outcome === 'picked' && decided.pick?.linkUrl) summary.ukSections++;
      summary.processed++;
    } catch (err) {
      summary.errored++;
      deps.log(`  ERROR row ${index + 1}: ${redacted(err, row)}`);
    }
    if ((index + 1) % HEARTBEAT_ROWS === 0) {
      deps.log(
        `  … ${index + 1}/${rows.length} rows, ${summary.asked} asked, ${summary.picked} picked`,
      );
    }
  }
  return summary;
}
