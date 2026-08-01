/**
 * Search-based website discovery — the third discoverer.
 *
 * CQC and Wikidata find websites by joining a registry on the company number.
 * That covers 6,750 companies. The other 109,000 have no registry entry naming
 * a website, so the only way to find one is to look for it.
 *
 * This job does NOT verify liveness and deliberately leaves `checked_at` NULL,
 * exactly as import-registry-websites does. It fetches pages, but only to
 * choose between candidates; the nightly sweep stays the single thing that
 * decides a URL renders. Two jobs claiming that would be two to keep in step.
 *
 * What it publishes follows from the existing ladder with no special case: a
 * candidate carrying the company's registration number lands at `crn_on_page`
 * and renders, one carrying only the registered postcode lands at
 * `postcode_on_page` and does not, because that tier is not in
 * PUBLISHABLE_EVIDENCE and has never been measured on a searched population.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/discover-websites-search.ts --dry-run --max-rows=20
 *   bun apps/web/scripts/discover-websites-search.ts --max-rows=500
 *
 * Env: POSTGRES_URL, SERPER_API_KEY.
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { evidenceConfidence } from '../src/lib/websites/decide.ts';
import {
  makeBankCandidates,
  makeMarkAttempt,
  makeRemaining,
  makeSelectUndiscovered,
  makeWriteOutcome,
} from '../src/lib/websites/discover-sql.ts';
import type { DiscoveryRow } from '../src/lib/websites/discover-sweep.ts';
import { discoverWebsites } from '../src/lib/websites/discover-sweep.ts';
import type { CandidateProbe } from '../src/lib/websites/discover.ts';
import {
  pageHasCompanyNumber,
  pageHasPostcode,
  visibleText,
} from '../src/lib/websites/extract.ts';
import { normaliseWebsiteUrl } from '../src/lib/websites/normalise-url.ts';
import {
  isAggregatorHost,
  looksParked,
} from '../src/lib/websites/page-signals.ts';
import { setGitHubOutput } from './ci-utils.ts';
import {
  ERROR_RATE_THRESHOLD,
  loadScriptEnv,
  parseStrictInt,
} from './lib/script-utils.ts';
import { searchCompany } from './lib/serper.ts';
import { fetchSite } from './lib/web-fetch.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

/** Ceiling on credits one run may spend. The only figure an input cannot raise. */
const ABSOLUTE_MAX_SEARCHES = 5000;

const dryRun = args.includes('--dry-run');
const maxRows = parseStrictInt(flag('max-rows') ?? '300', 'max-rows');
/** Defaults to the row count: one search per company, and never a surprise. */
const maxSearches = Math.min(
  parseStrictInt(flag('max-searches') ?? String(maxRows), 'max-searches'),
  ABSOLUTE_MAX_SEARCHES,
);
const delayMs = parseStrictInt(flag('delay') ?? '400', 'delay');

const apiKey = process.env.SERPER_API_KEY;
if (!apiKey) {
  console.error('  SERPER_API_KEY is not set');
  process.exit(1);
}

const sql = neon(process.env.POSTGRES_URL as string);
const remaining = makeRemaining(sql);
const before = await remaining();

console.log(
  `Search website discovery — db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(
  `  max-rows: ${maxRows}  max-searches: ${maxSearches}  delay: ${delayMs}ms`,
);
console.log(
  `  before: ${before.target} companies undiscovered, ${before.discovered} already searched`,
);

/** Fetch one candidate and read the two query-independent signals off it. */
async function probe(
  row: DiscoveryRow,
  url: string,
): Promise<CandidateProbe | null> {
  // Raw provider output, so normalise as every other writer of url does.
  const canonical = normaliseWebsiteUrl(url);
  if (!canonical) return null;
  const fetched = await fetchSite(canonical);
  if (!fetched.ok) return null;
  const host = (() => {
    try {
      return new URL(fetched.url).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  const text = visibleText(fetched.html);
  return {
    // Store the URL we ASKED for, not the post-redirect one: that is what a
    // visitor clicks and what the sweep will revalidate. The host is judged
    // post-redirect for the same reason it is in the sweep — a stored URL that
    // 301s into a directory has to be judged on where it lands.
    url: canonical,
    crnFound: pageHasCompanyNumber(fetched.html, row.companyNumber),
    postcodeFound: row.postcode
      ? pageHasPostcode(fetched.html, row.postcode)
      : false,
    onAggregator: isAggregatorHost(host),
    parked: looksParked(text),
  };
}

const writeOutcome = makeWriteOutcome(sql);

const summary = await discoverWebsites(
  { maxRows, maxSearches, delayMs, dryRun },
  {
    selectRows: makeSelectUndiscovered(sql),
    search: async (query) => {
      const result = await searchCompany(query, apiKey);
      return result.ok
        ? { ok: true, urls: result.urls }
        : { ok: false, reason: result.reason };
    },
    bankCandidates: makeBankCandidates(sql),
    markAttempt: makeMarkAttempt(sql),
    probe,
    write: (row, outcome) =>
      writeOutcome(row, outcome, evidenceConfidence(outcome.evidence)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  },
);

const after = await remaining();
const found = summary.foundByNumber + summary.foundByAddress;
// Rows decided, not credits spent: retries settle without spending one.
const decided =
  summary.foundByNumber + summary.foundByAddress + summary.foundNothing;
const hitRate = decided === 0 ? 0 : (found / decided) * 100;

console.log('\n─── summary ───');
console.log(`  selected            : ${summary.selected}`);
console.log(`  processed           : ${summary.processed}`);
console.log(`  searched            : ${summary.searched}`);
console.log(`  found_by_number     : ${summary.foundByNumber}`);
console.log(`  found_by_address    : ${summary.foundByAddress}`);
console.log(`  found_nothing       : ${summary.foundNothing}`);
console.log(`  hit_rate            : ${hitRate.toFixed(1)}%`);
console.log(`  candidate_fetches   : ${summary.candidateFetches}`);
console.log(`  unsearchable        : ${summary.unsearchable}`);
console.log(`  written             : ${summary.written}`);
console.log(`  unreadable          : ${summary.unreadable}`);
console.log(`  retried             : ${summary.retried}`);
console.log(`  unpersisted         : ${summary.unpersisted}`);
console.log(`  errored             : ${summary.errored}`);
console.log(`  credits_lost        : ${summary.creditsLost}`);
console.log(`  stopped_early       : ${summary.stoppedEarly || 'no'}`);
console.log(`  undiscovered_left   : ${after.target}`);
console.log(`  credits_spent       : ${summary.searched}`);

setGitHubOutput('searched', String(summary.searched));
setGitHubOutput('found', String(found));
setGitHubOutput('undiscovered-left', String(after.target));

// A run that stopped on credits or a failing provider is not a healthy run,
// and the workflow should show red rather than a green tick over a slice that
// did almost nothing.
if (summary.stoppedEarly === 'out_of_credits') {
  console.error('\n  Serper balance exhausted — top up before the next run.');
  process.exit(1);
}
if (summary.stoppedEarly === 'search_failing') {
  console.error(
    '\n  Searches failed repeatedly — check the key and the provider.',
  );
  process.exit(1);
}
/** Rows below which the error rate is too small a sample to act on. */
const MIN_GATE_SAMPLE = 25;

// Rows reached, and every outcome that spent a credit without storing an answer.
const attempted = summary.processed - summary.unsearchable;
const wasted = summary.errored + summary.unreadable + summary.unpersisted;
const errorRate = attempted === 0 ? 0 : wasted / attempted;
if (attempted >= MIN_GATE_SAMPLE && errorRate > ERROR_RATE_THRESHOLD) {
  console.error(
    `\n  ${wasted}/${attempted} rows produced nothing (${(errorRate * 100).toFixed(1)}%) — above the ${(ERROR_RATE_THRESHOLD * 100).toFixed(0)}% threshold.`,
  );
  console.error(
    `  errored: ${summary.errored}  unreadable: ${summary.unreadable}  unpersisted: ${summary.unpersisted}`,
  );
  process.exit(1);
}
if (summary.creditsLost > 0) {
  console.error(
    `\n  ${summary.creditsLost} searches were charged but not persisted — those companies will be re-searched.`,
  );
  process.exit(1);
}
