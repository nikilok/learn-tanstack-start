/**
 * Website revalidation sweep — the liveness half of company website discovery.
 *
 * Fetches each stored URL, confirms it still resolves, and looks for the
 * company's registered number on the site. Stamping `checked_at` is the whole
 * point: the render gate is `status = 'verified' AND checked_at IS NOT NULL`,
 * so until a row has been through here it cannot be shown, however sound the
 * registry join behind it. Only 74% of imported URLs actually resolve.
 *
 * One bounded slice per run, oldest-checked first, so the cursor rotates
 * through the table without needing to remember where it got to — the same
 * shape as the phase5 sweeps. Each run then refreshes every row's postcode
 * share and named url, which the publish gate reads
 * (lib/websites/postcode-share.ts, lib/websites/named-url.ts).
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/sweep-websites.ts --dry-run --max-rows=20 --verbose
 *   bun apps/web/scripts/sweep-websites.ts --max-rows=500
 *   bun apps/web/scripts/sweep-websites.ts            # full slice (CI)
 *
 * Env: POSTGRES_URL. WEBSITE_SWEEP_DELAY_MS overrides the pacing.
 * COMPANIES_HOUSE_SEED_API_KEY lets a `name_and_place` row's officer be re-read.
 * A `name_and_place` homepage that shows a plain fetch nothing is read in
 * headless Chromium; `--no-render` skips that, as does a browser that will not
 * start, which leaves such a row as it was.
 */

import { createClient, neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { makeRefreshNamedUrls } from '../src/lib/websites/named-url.ts';
import { makeRefreshPostcodeShares } from '../src/lib/websites/postcode-share.ts';
import { makeCoverage } from '../src/lib/websites/sql.ts';
import { sweepWebsites } from '../src/lib/websites/sweep.ts';
import { setGitHubOutput } from './ci-utils.ts';
import { makeOfficerLookup } from './lib/ch-officers.ts';
import {
  ERROR_RATE_THRESHOLD,
  loadScriptEnv,
  parseStrictInt,
} from './lib/script-utils.ts';
import { makeSweepDeps } from './lib/sweep-deps.ts';
import { launchRenderer, type Renderer } from './lib/web-render.ts';

loadScriptEnv(import.meta.url);

/** Measured ON THE RUNNER, not locally: 40 rows took 260s on a first pass, so
 *  6.5s/row once GitHub's egress and DNS are in the path. 600 rows is then
 *  ~65 minutes of a 120-minute job — a margin that survives a slice carrying
 *  more 12s timeouts than this sample did. (900 would have been ~98 minutes,
 *  which is too close.) The 6,641-row backlog drains in about eleven nights;
 *  later passes are liveness only and much quicker. */
const DEFAULT_MAX_ROWS = 600;
/** Politeness pacing. Every row is a different host, so this is courtesy
 *  rather than rate-limit avoidance — but it also keeps the job from looking
 *  like a burst to anyone watching their access log. */
const DEFAULT_DELAY_MS = 250;
/** Homepage plus this many legal/contact pages. Each one multiplies the request
 *  count across the whole table, and a disclosure is on the homepage, one click
 *  away, or effectively absent. */
const MAX_DISCLOSURE_PATHS = 2;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
/** Per-row detail, for a human at a terminal. Never set by the workflow. */
const verbose = args.includes('--verbose');
const maxRowsArg = args.find((a) => a.startsWith('--max-rows='))?.split('=')[1];
const maxRows = maxRowsArg
  ? parseStrictInt(maxRowsArg, '--max-rows')
  : DEFAULT_MAX_ROWS;
const delayMs = process.env.WEBSITE_SWEEP_DELAY_MS
  ? parseStrictInt(process.env.WEBSITE_SWEEP_DELAY_MS, 'WEBSITE_SWEEP_DELAY_MS')
  : DEFAULT_DELAY_MS;

const sql = neon(process.env.POSTGRES_URL as string);
const coverage = makeCoverage(createClient(process.env.POSTGRES_URL as string));
const chKey = process.env.COMPANIES_HOUSE_SEED_API_KEY;
const refreshPostcodeShares = makeRefreshPostcodeShares((text) =>
  sql.query(text),
);
const refreshNamedUrls = makeRefreshNamedUrls((text, params) =>
  sql.query(text, params),
);

const startedAt = Date.now();
console.log(
  `Website revalidation sweep — db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(`  max-rows: ${maxRows}  delay: ${delayMs}ms`);
if (!chKey) console.log('  officer re-check: off, no Companies House key');
let renderer: Renderer | null = null;
if (!args.includes('--no-render')) {
  try {
    renderer = await launchRenderer();
  } catch (err) {
    console.log(
      `  render re-check: off, the browser would not start (${err instanceof Error ? err.name : 'unknown'})`,
    );
  }
}

const before = await coverage();
console.log(
  `  before: ${before.renderable}/${before.sponsors} renderable, ${before.neverChecked} never checked`,
);

const summary = await sweepWebsites(
  {
    maxRows,
    delayMs,
    maxDisclosurePaths: MAX_DISCLOSURE_PATHS,
    dryRun,
    // Explicit opt-in only. The repo is public and Actions logs are
    // world-readable, so a per-row line would publish the company/URL pairs the
    // crawl produces. Nothing infers this from the environment — the workflow
    // never passes --verbose, so CI cannot turn it on by accident.
    logRows: verbose,
  },
  makeSweepDeps(
    sql,
    (message) => console.log(message),
    chKey ? makeOfficerLookup({ apiKey: chKey, workers: 1 }) : undefined,
    renderer ?? undefined,
  ),
).finally(() => renderer?.close());

// After the slice, so a failed refresh never costs the run its liveness work.
let sharesMoved: number | null = null;
try {
  sharesMoved = await refreshPostcodeShares(dryRun);
} catch (err) {
  console.error(
    `  postcode share refresh failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}
let namedUrlsMoved: number | null = null;
try {
  namedUrlsMoved = await refreshNamedUrls(dryRun);
} catch (err) {
  console.error(
    `  named url refresh failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const after = await coverage();
const durationSec = Math.round((Date.now() - startedAt) / 1000);

console.log('\n─── summary ───');
console.log(`  selected            : ${summary.selected}`);
console.log(`  live                : ${summary.live}`);
console.log(`  dead                : ${summary.dead}`);
console.log(`  robots_blocked      : ${summary.robotsBlocked}`);
console.log(`  promoted            : ${summary.promoted}`);
console.log(`  adopted_variant     : ${summary.adoptedVariant}`);
console.log(`  disclosure_fetches  : ${summary.disclosureFetches}`);
console.log(`  corroborated        : ${summary.corroborated}`);
console.log(`  demoted             : ${summary.demoted}`);
console.log(`  no_site_there       : ${summary.noSiteThere}`);
console.log(`  name_place_gone     : ${summary.nameAndPlaceGone}`);
console.log(`  name_place_unread   : ${summary.nameAndPlaceUnread}`);
console.log(`  name_place_rendered : ${summary.nameAndPlaceRendered}`);
console.log(`  updated             : ${summary.updated}`);
console.log(`  lock_missed         : ${summary.lockMissed}`);
console.log(`  errored             : ${summary.errored}`);
console.log(`  systemic_abort      : ${summary.systemicAbort}`);
console.log(`  postcode_shares     : ${sharesMoved ?? 'failed'}`);
console.log(`  named_urls          : ${namedUrlsMoved ?? 'failed'}`);
console.log(`  never_checked_left  : ${after.neverChecked}`);
console.log(`  dead_total          : ${after.deadTotal}`);
console.log(
  `  sponsor_renderable  : ${after.renderable}/${after.sponsors} (${((after.renderable / after.sponsors) * 100).toFixed(2)}%)`,
);
console.log(`  duration            : ${durationSec}s`);

setGitHubOutput('renderable-sponsors', String(after.renderable));
setGitHubOutput('never-checked', String(after.neverChecked));

// Loud failure, same posture as the phase5 sweeps: a rate computed over what
// actually happened, so an early abort cannot dilute it below the threshold.
if (
  summary.selected > 0 &&
  summary.errored / summary.selected > ERROR_RATE_THRESHOLD
) {
  console.error(
    '\n  ERROR RATE above 10% — the fetcher or the database is unhealthy.',
  );
  process.exit(1);
}
// The sweep now stops itself mid-slice rather than committing a whole night of
// demotions from a broken runner, so this only reports what already happened.
if (summary.systemicAbort) {
  console.error(
    '\n  ABORTED: nothing was reachable — check egress. The run stopped early, so only the first few rows were demoted.',
  );
  process.exit(1);
}
// Stale shares keep publishing what they last allowed, and new postcode rows
// cannot publish at all, so this must not pass as a healthy run.
if (sharesMoved === null) {
  console.error('\n  POSTCODE SHARES were not refreshed.');
  process.exit(1);
}
// A url changed this run cannot publish through its host until this runs again.
if (namedUrlsMoved === null) {
  console.error('\n  NAMED URLS were not refreshed.');
  process.exit(1);
}
