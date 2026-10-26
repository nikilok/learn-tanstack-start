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
 * What it publishes follows from the existing ladder: a candidate carrying the
 * company's registration number lands at `crn_on_page` and renders; one
 * carrying only the registered postcode lands at `postcode_on_page` and
 * renders only where at most ten mapped companies share that postcode, the
 * slice a hand-labelled sample measured (lib/websites/publishable.ts); one
 * proved by the two-signal rule lands at `name_and_place` and renders. A
 * candidate whose homepage shows a plain fetch nothing is read again in
 * headless Chromium; `--no-render` skips that.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/discover-websites-search.ts --dry-run --max-rows=20
 *   bun apps/web/scripts/discover-websites-search.ts --max-rows=500
 *   bun apps/web/scripts/discover-websites-search.ts --shard=3/8 --max-rows=4000
 *
 * Parallel workers each take one `--shard=K/N`, all with the same N. Pause the
 * scheduled workflow while local workers run: it takes the whole set, so it
 * would search their companies too.
 *
 * Env: POSTGRES_URL, SERPER_API_KEY, COMPANIES_HOUSE_SEED_API_KEY.
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { evidenceConfidence } from '../src/lib/websites/decide.ts';
import {
  makeBankCandidates,
  makeCrowdedHosts,
  makeMarkAttempt,
  makeRemaining,
  makeSelectUndiscovered,
  makeWriteOutcome,
} from '../src/lib/websites/discover-sql.ts';
import { discoverWebsites } from '../src/lib/websites/discover-sweep.ts';
import { DISCLOSURE_PATHS } from '../src/lib/websites/fetch-policy.ts';
import { parseShard, workerSearchCeiling } from '../src/lib/websites/shard.ts';
import { setGitHubOutput } from './ci-utils.ts';
import { makeOfficerLookup, OFFICER_BREAKER } from './lib/ch-officers.ts';
import {
  ERROR_RATE_THRESHOLD,
  loadScriptEnv,
  parseStrictInt,
} from './lib/script-utils.ts';
import { searchCompany } from './lib/serper.ts';
import { launchRenderer } from './lib/web-render.ts';
import {
  probeOrigin,
  renderCandidate,
  walkDisclosure,
} from './lib/website-probe.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

/** Every argument this script reads. Anything else stops the run: a typo such
 *  as `--shards=3/8`, or `--shard 3/8`, would run the whole set and pay for
 *  every other worker's companies. */
const KNOWN_ARG =
  /^--(?:dry-run|no-render|(?:shard|max-rows|max-searches|delay|max-disclosure)=.*)$/;
const unknownArgs = args.filter((a) => !KNOWN_ARG.test(a));
if (unknownArgs.length > 0) {
  console.error(`  Unknown arguments: ${unknownArgs.join(' ')}`);
  process.exit(1);
}

const dryRun = args.includes('--dry-run');
const shard = parseShard(flag('shard'));
const maxRows = parseStrictInt(flag('max-rows') ?? '120', 'max-rows');
/**
 * Defaults to the row count: one search per company, and never a surprise.
 * The ceiling is the only figure an input cannot raise, and it shrinks as the
 * split widens so a whole split stays under one run's worth.
 */
const maxSearches = Math.min(
  parseStrictInt(flag('max-searches') ?? String(maxRows), 'max-searches'),
  workerSearchCeiling(shard),
);
const delayMs = parseStrictInt(flag('delay') ?? '400', 'delay');
/** Fixed paths walked on a candidate, after its homepage's legal links and before its about links: all nine reach the about pages. */
const MAX_DISCLOSURE_PATHS = parseStrictInt(
  flag('max-disclosure') ?? String(DISCLOSURE_PATHS.length),
  'max-disclosure',
);
let disclosureFetches = 0;
let renderFetches = 0;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const apiKey = process.env.SERPER_API_KEY;
if (!apiKey) {
  console.error('  SERPER_API_KEY is not set');
  process.exit(1);
}
const chKey = process.env.COMPANIES_HOUSE_SEED_API_KEY;
if (!chKey) {
  console.error('  COMPANIES_HOUSE_SEED_API_KEY is not set');
  process.exit(1);
}

// Started before anything is spent: a browser that will not start stops the run here.
const renderer = args.includes('--no-render') ? null : await launchRenderer();

const sql = neon(process.env.POSTGRES_URL as string);
const remaining = makeRemaining(sql);
const before = await remaining();

console.log(
  `Search website discovery — db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(
  `  shard: ${shard.index}/${shard.count}  max-rows: ${maxRows}  max-searches: ${maxSearches}  delay: ${delayMs}ms`,
);
console.log(
  `  before: ${before.target} companies undiscovered, ${before.discovered} already searched`,
);
const crowdedHosts = await makeCrowdedHosts(sql)();
console.log(`  crowded hosts: ${crowdedHosts.size}`);

const writeOutcome = makeWriteOutcome(sql);
const walkOptions = {
  maxPaths: MAX_DISCLOSURE_PATHS,
  crowded: crowdedHosts,
  delayMs,
};

const summary = await discoverWebsites(
  { maxRows, maxSearches, delayMs, dryRun },
  {
    selectRows: makeSelectUndiscovered(sql, shard),
    crowdedHosts,
    search: async (query) => {
      const result = await searchCompany(query, apiKey);
      // Failures pass through WHOLE rather than field-by-field. Rebuilding
      // them dropped `charged`, which is how the orchestrator knows a
      // malformed 200 still cost a credit — so the fix for that existed in the
      // client and in the sweep, and died in the four lines between them.
      return result.ok ? { ok: true, urls: result.urls } : result;
    },
    bankCandidates: makeBankCandidates(sql),
    markAttempt: makeMarkAttempt(sql),
    probe: (row, url) => probeOrigin(row, url, crowdedHosts),
    officers: makeOfficerLookup({ apiKey: chKey, workers: shard.count }),
    walkDisclosure: (row, base) =>
      walkDisclosure(row, base, {
        ...walkOptions,
        onFetch: () => {
          disclosureFetches += 1;
        },
      }),
    render: renderer
      ? (row, base) =>
          renderCandidate(row, base, renderer, {
            ...walkOptions,
            onFetch: () => {
              renderFetches += 1;
            },
          })
      : undefined,
    write: (row, outcome) =>
      writeOutcome(row, outcome, evidenceConfidence(outcome.evidence)),
    sleep,
    log: (message) => console.log(message),
  },
).finally(() => renderer?.close());

const after = await remaining();
const found =
  summary.foundByNumber + summary.foundByAddress + summary.foundByNameAndPlace;
// Rows decided, not credits spent: retries settle without spending one.
const decided = found + summary.foundNothing;
const hitRate = decided === 0 ? 0 : (found / decided) * 100;

console.log('\n─── summary ───');
console.log(`  selected            : ${summary.selected}`);
console.log(`  processed           : ${summary.processed}`);
console.log(`  searched            : ${summary.searched}`);
console.log(`  found_by_number     : ${summary.foundByNumber}`);
console.log(`  found_by_address    : ${summary.foundByAddress}`);
console.log(`  found_by_name_place : ${summary.foundByNameAndPlace}`);
console.log(`  found_nothing       : ${summary.foundNothing}`);
console.log(`  hit_rate            : ${hitRate.toFixed(1)}%`);
console.log(`  candidate_fetches   : ${summary.candidateFetches}`);
console.log(`  disclosure_fetches  : ${disclosureFetches}`);
console.log(`  officer_lookups     : ${summary.officerLookups}`);
console.log(`  officer_failures    : ${summary.officerFailures}`);
console.log(`  rendered            : ${summary.rendered}`);
console.log(`  render_fetches      : ${renderFetches}`);
console.log(`  found_by_render     : ${summary.foundByRender}`);
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
if (summary.officerFailures >= OFFICER_BREAKER) {
  console.error(
    `\n  ${summary.officerFailures} companies' officers could not be read from Companies House; they are left for the next run.`,
  );
  process.exit(1);
}
