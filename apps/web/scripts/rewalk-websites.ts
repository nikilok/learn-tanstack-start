/**
 * Re-walk the search rows discovery has already settled, at zero search
 * credits: `none` rows from their banked results, postcode rows on their
 * stored site. Upgrades only; every statutory company number the pages state
 * is recorded in website_stated_numbers. Changed rows wait for the sweep
 * before they render.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/rewalk-websites.ts --dry-run --max-rows=50
 *   bun apps/web/scripts/rewalk-websites.ts --shard=3/8 --max-rows=1500
 *   bun apps/web/scripts/rewalk-websites.ts --sample=150 --seed=rewalk-2026-10-20 --evidence=none
 *
 * `--sample` draws a seeded random sample and is always a dry run.
 *
 * Env: POSTGRES_URL.
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { evidenceConfidence } from '../src/lib/websites/decide.ts';
import { makeCrowdedHosts } from '../src/lib/websites/discover-sql.ts';
import {
  makeMarkUnreadable,
  makeMarkWalked,
  makeRecordStated,
  makeRewalkRemaining,
  makeSelectRewalk,
  makeUpgrade,
} from '../src/lib/websites/rewalk-sql.ts';
import { lostNetwork, rewalkWebsites } from '../src/lib/websites/rewalk.ts';
import { parseShard } from '../src/lib/websites/shard.ts';
import { setGitHubOutput } from './ci-utils.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';
import { probeOrigin, walkDisclosure } from './lib/website-probe.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

/** Every argument this script reads; anything else stops the run. */
const KNOWN_ARG =
  /^--(?:dry-run|(?:shard|max-rows|delay|max-disclosure|sample|seed|evidence)=.*)$/;
const unknownArgs = args.filter((a) => !KNOWN_ARG.test(a));
if (unknownArgs.length > 0) {
  console.error(`  Unknown arguments: ${unknownArgs.join(' ')}`);
  process.exit(1);
}

const sample = flag('sample');
const seed = flag('seed');
if (sample && !seed) {
  console.error('  --sample needs --seed');
  process.exit(1);
}
const evidenceFlag = flag('evidence');
if (evidenceFlag && !['none', 'postcode'].includes(evidenceFlag)) {
  console.error('  --evidence must be none or postcode');
  process.exit(1);
}
const evidence =
  evidenceFlag === 'postcode'
    ? 'postcode_on_page'
    : (evidenceFlag as 'none' | undefined);
const dryRun = args.includes('--dry-run') || Boolean(sample);
const shard = parseShard(flag('shard'));
const maxRows = parseStrictInt(sample ?? flag('max-rows') ?? '500', 'max-rows');
const delayMs = parseStrictInt(flag('delay') ?? '400', 'delay');
const maxPaths = parseStrictInt(
  flag('max-disclosure') ?? '7',
  'max-disclosure',
);
let disclosureFetches = 0;

const sql = neon(process.env.POSTGRES_URL as string);
console.log(
  `Website re-walk — db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(
  `  shard: ${shard.index}/${shard.count}  max-rows: ${maxRows}  delay: ${delayMs}ms${sample ? '  seeded sample' : ''}${evidence ? `  evidence: ${evidence}` : ''}`,
);
if (!sample) {
  const left = await makeRewalkRemaining(sql)();
  console.log(
    `  before: ${left.none} none rows, ${left.postcode} postcode rows to walk`,
  );
}
const crowdedHosts = await makeCrowdedHosts(sql)();
console.log(`  crowded hosts: ${crowdedHosts.size}`);

const upgrade = makeUpgrade(sql);
const started = Date.now();
const summary = await rewalkWebsites(
  { maxRows, delayMs, dryRun },
  {
    selectRows: makeSelectRewalk(sql, {
      shard,
      evidence,
      seed: sample ? seed : undefined,
    }),
    crowdedHosts,
    probe: (row, url) => probeOrigin(row, url, crowdedHosts),
    walkDisclosure: (row, base) =>
      walkDisclosure(row, base, {
        maxPaths,
        crowded: crowdedHosts,
        delayMs,
        onFetch: () => {
          disclosureFetches += 1;
        },
      }),
    upgrade: (row, outcome) =>
      upgrade(row, outcome, evidenceConfidence(outcome.evidence)),
    markWalked: makeMarkWalked(sql),
    markUnreadable: makeMarkUnreadable(sql),
    recordStated: makeRecordStated(sql),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  },
);
const minutes = (Date.now() - started) / 60_000;

console.log('\n─── summary ───');
console.log(`  selected            : ${summary.selected}`);
console.log(`  processed           : ${summary.processed}`);
console.log(`  none_to_number      : ${summary.noneToNumber}`);
console.log(`  none_to_postcode    : ${summary.noneToPostcode}`);
console.log(`  postcode_to_number  : ${summary.postcodeToNumber}`);
console.log(`  unchanged           : ${summary.unchanged}`);
console.log(`  unreadable          : ${summary.unreadable}`);
console.log(`  unpersisted         : ${summary.unpersisted}`);
console.log(`  errored             : ${summary.errored}`);
console.log(`  candidate_fetches   : ${summary.candidateFetches}`);
console.log(`  disclosure_fetches  : ${disclosureFetches}`);
console.log(`  stated_numbers      : ${summary.statedNumbers}`);
console.log(`  minutes             : ${minutes.toFixed(1)}`);
if (!sample) {
  const left = await makeRewalkRemaining(sql)();
  console.log(
    `  left                : ${left.none} none, ${left.postcode} postcode`,
  );
  setGitHubOutput('left', String(left.none + left.postcode));
}
setGitHubOutput(
  'upgraded',
  String(
    summary.noneToNumber + summary.noneToPostcode + summary.postcodeToNumber,
  ),
);

/** Rows below which a failure rate is too small a sample to act on. */
const MIN_GATE_SAMPLE = 25;
// A dead site is an ordinary answer here; a run that can read almost nothing,
// or that throws, has lost its network or its database.
const reached = summary.processed;
if (lostNetwork(summary)) {
  console.error(
    `\n  ${summary.firstAttemptsUnreadable}/${summary.firstAttempts} first attempts unreadable — check the runner's network.`,
  );
  process.exit(1);
}
if (reached >= MIN_GATE_SAMPLE && summary.errored / reached > 0.1) {
  console.error(
    `\n  ${summary.errored}/${reached} rows threw — above the 10% threshold.`,
  );
  process.exit(1);
}
