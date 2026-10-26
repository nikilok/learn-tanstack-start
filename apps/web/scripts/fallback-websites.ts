/**
 * The fallback for search rows every proof has left empty: a site picker
 * chooses among a row's banked candidates, and a choice whose own domain
 * names the company, on a homepage that is not a holding page, is written as
 * `assessed`. Changed rows wait for the sweep before they render, and the
 * tier renders only while its arm is switched on (publishable.ts).
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/fallback-websites.ts --dry-run --max-rows=50
 *   bun apps/web/scripts/fallback-websites.ts --shard=3/8 --max-rows=500
 *
 * Env: POSTGRES_URL; PICKER_MODULE, the installed picker's entry; and
 * PICKER_API_KEY, its key.
 */

import { neon } from '@ss/db/client';

import sicDescriptions from '../data/sic-codes.json';
import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { makeCrowdedHosts } from '../src/lib/websites/discover-sql.ts';
import {
  makeFallbackRemaining,
  makeMarkSettled,
  makeSelectFallback,
  makeWritePick,
} from '../src/lib/websites/fallback-sql.ts';
import {
  type FallbackPage,
  fallbackWebsites,
  lostNetwork,
} from '../src/lib/websites/fallback.ts';
import { parseShard } from '../src/lib/websites/shard.ts';
import { setGitHubOutput } from './ci-utils.ts';
import {
  ERROR_RATE_THRESHOLD,
  loadScriptEnv,
  parseStrictInt,
} from './lib/script-utils.ts';
import { loadPicker } from './lib/site-picker.ts';
import { fetchPage, fetchSite, type PageFetch } from './lib/web-fetch.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

/** Every argument this script reads; anything else stops the run. */
const KNOWN_ARG = /^--(?:dry-run|(?:shard|max-rows|delay)=.*)$/;
const unknownArgs = args.filter((a) => !KNOWN_ARG.test(a));
if (unknownArgs.length > 0) {
  console.error(`  Unknown arguments: ${unknownArgs.join(' ')}`);
  process.exit(1);
}

const dryRun = args.includes('--dry-run');
const shard = parseShard(flag('shard'));
const maxRows = parseStrictInt(flag('max-rows') ?? '500', 'max-rows');
const delayMs = parseStrictInt(flag('delay') ?? '400', 'delay');

// Loaded before any row is read: a missing or broken picker stops the run here.
const pick = await loadPicker(
  process.env.PICKER_MODULE,
  process.env.PICKER_API_KEY,
);

/** A fetch result as the fallback reads it. */
const asPage = (result: PageFetch): FallbackPage =>
  result.ok ? { ok: true, url: result.url, html: result.html } : { ok: false };

const sql = neon(process.env.POSTGRES_URL as string);
console.log(
  `Website fallback: db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(
  `  shard: ${shard.index}/${shard.count}  max-rows: ${maxRows}  delay: ${delayMs}ms`,
);
const remaining = makeFallbackRemaining(sql);
console.log(`  before: ${await remaining()} rows to settle`);
const crowdedHosts = await makeCrowdedHosts(sql)();
console.log(`  crowded hosts: ${crowdedHosts.size}`);

const started = Date.now();
const summary = await fallbackWebsites(
  { maxRows, delayMs, dryRun },
  {
    selectRows: makeSelectFallback(sql, sicDescriptions, shard),
    crowdedHosts,
    fetchSite: async (url) => asPage(await fetchSite(url)),
    fetchPage: async (url) => asPage(await fetchPage(url)),
    pick,
    writePick: makeWritePick(sql),
    markSettled: makeMarkSettled(sql),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  },
);
const minutes = (Date.now() - started) / 60_000;

console.log('\n─── summary ───');
console.log(`  selected            : ${summary.selected}`);
console.log(`  processed           : ${summary.processed}`);
console.log(`  none_named          : ${summary.noneNamed}`);
console.log(`  none_readable       : ${summary.noneReadable}`);
console.log(`  asked               : ${summary.asked}`);
console.log(`  picked              : ${summary.picked}`);
console.log(`  uk_sections         : ${summary.ukSections}`);
console.log(`  below_threshold     : ${summary.belowThreshold}`);
console.log(`  not_named           : ${summary.notNamed}`);
console.log(`  holding_page        : ${summary.holdingPage}`);
console.log(`  unavailable         : ${summary.unavailable}`);
console.log(`  unpersisted         : ${summary.unpersisted}`);
console.log(`  errored             : ${summary.errored}`);
console.log(`  homepage_fetches    : ${summary.homepageFetches}`);
console.log(`  homepage_failures   : ${summary.homepageFailures}`);
console.log(`  tokens              : ${summary.tokens}`);
console.log(`  minutes             : ${minutes.toFixed(1)}`);
const left = await remaining();
console.log(`  left                : ${left}`);
setGitHubOutput('left', String(left));
setGitHubOutput('picked', String(summary.picked));

/** Rows below which a failure rate is too small a sample to act on. */
const MIN_GATE_SAMPLE = 25;
if (lostNetwork(summary)) {
  console.error(
    `\n  ${summary.homepageFailures}/${summary.homepageFetches} homepages did not load; check the runner's network.`,
  );
  process.exit(1);
}
const reached = summary.processed + summary.errored;
if (
  reached >= MIN_GATE_SAMPLE &&
  summary.errored / reached > ERROR_RATE_THRESHOLD
) {
  console.error(
    `\n  ${summary.errored}/${reached} rows threw, above the ${ERROR_RATE_THRESHOLD * 100}% threshold.`,
  );
  process.exit(1);
}
if (
  summary.asked >= MIN_GATE_SAMPLE &&
  summary.unavailable / summary.asked > ERROR_RATE_THRESHOLD
) {
  console.error(
    `\n  ${summary.unavailable}/${summary.asked} rows got no answer from the picker; they are left for the next run.`,
  );
  process.exit(1);
}
