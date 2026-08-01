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
import {
  isAggregatorHost,
  looksParked,
} from '../src/lib/websites/page-signals.ts';
import { setGitHubOutput } from './ci-utils.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';
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

const dryRun = args.includes('--dry-run');
const maxRows = parseStrictInt(flag('max-rows') ?? '300', 'max-rows');
/** Defaults to the row count: one search per company, and never a surprise. */
const maxSearches = parseStrictInt(
  flag('max-searches') ?? String(maxRows),
  'max-searches',
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
  const fetched = await fetchSite(url);
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
    url,
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
    probe,
    write: (row, outcome) =>
      writeOutcome(row, outcome, evidenceConfidence(outcome.evidence)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  },
);

const after = await remaining();
const found = summary.foundByNumber + summary.foundByAddress;
const hitRate = summary.searched === 0 ? 0 : (found / summary.searched) * 100;

console.log('\n─── summary ───');
console.log(`  selected            : ${summary.selected}`);
console.log(`  searched            : ${summary.searched}`);
console.log(`  found_by_number     : ${summary.foundByNumber}`);
console.log(`  found_by_address    : ${summary.foundByAddress}`);
console.log(`  found_nothing       : ${summary.foundNothing}`);
console.log(`  hit_rate            : ${hitRate.toFixed(1)}%`);
console.log(`  candidate_fetches   : ${summary.candidateFetches}`);
console.log(`  unsearchable        : ${summary.unsearchable}`);
console.log(`  written             : ${summary.written}`);
console.log(`  errored             : ${summary.errored}`);
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
