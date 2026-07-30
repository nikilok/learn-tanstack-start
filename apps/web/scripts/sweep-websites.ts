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
 * shape as the phase5 sweeps.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/sweep-websites.ts --dry-run --max-rows=20 --verbose
 *   bun apps/web/scripts/sweep-websites.ts --max-rows=500
 *   bun apps/web/scripts/sweep-websites.ts            # full slice (CI)
 *
 * Env: POSTGRES_URL. WEBSITE_SWEEP_DELAY_MS overrides the pacing.
 */

import { neon } from '@ss/db/client';

import { describeDbHost } from '../src/lib/phase5/db-host.ts';
import {
  pageHasCompanyNumber,
  pageHasPostcode,
} from '../src/lib/websites/extract.ts';
import {
  makeApplyResult,
  makeCoverage,
  makeSelectRows,
  makeSleep,
} from '../src/lib/websites/sql.ts';
import type { FetchedPage } from '../src/lib/websites/sweep.ts';
import { sweepWebsites } from '../src/lib/websites/sweep.ts';
import { setGitHubOutput } from './ci-utils.ts';
import {
  ERROR_RATE_THRESHOLD,
  loadScriptEnv,
  parseStrictInt,
} from './lib/script-utils.ts';
import {
  fetchPage as fetchOnePage,
  fetchSite as fetchOneSite,
  type SiteFetch,
} from './lib/web-fetch.ts';

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
const coverage = makeCoverage(sql);

/** Adapt web-fetch's result to the shape the orchestrator asks for, so the
 *  sweep never has to know about HTTP. */
function toFetchedPage(result: SiteFetch, requested: string): FetchedPage {
  if (result.ok) {
    return {
      ok: true,
      url: result.url,
      html: result.html,
      attemptedUrl: result.attemptedUrl,
    };
  }
  return {
    ok: false,
    reason: result.reason,
    attemptedUrl: result.attemptedUrl ?? requested,
    status: result.status,
  };
}

const startedAt = Date.now();
console.log(
  `Website revalidation sweep — db ${describeDbHost(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(`  max-rows: ${maxRows}  delay: ${delayMs}ms`);

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
  {
    selectRows: makeSelectRows(sql),
    fetchSite: async (url) => toFetchedPage(await fetchOneSite(url), url),
    fetchPage: async (url) =>
      toFetchedPage(
        { ...(await fetchOnePage(url)), attempts: 1, attemptedUrl: url },
        url,
      ),
    hasCompanyNumber: pageHasCompanyNumber,
    hasPostcode: pageHasPostcode,
    applyResult: makeApplyResult(sql),
    sleep: makeSleep(),
    log: (message) => console.log(message),
  },
);

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
console.log(`  updated             : ${summary.updated}`);
console.log(`  lock_missed         : ${summary.lockMissed}`);
console.log(`  errored             : ${summary.errored}`);
console.log(`  systemic_abort      : ${summary.systemicAbort}`);
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
