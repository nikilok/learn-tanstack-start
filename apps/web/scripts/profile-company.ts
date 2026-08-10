/**
 * Company-profiles harness — the CLI over the same lib modules the nightly
 * job will use. Step-3 shape: crawl and snapshot only, so the corpus can be
 * validated before any model work exists (--no-extract is REQUIRED until
 * extraction lands).
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/profile-company.ts --origin=https://example.co.uk --no-extract --verbose
 *   bun apps/web/scripts/profile-company.ts --company=12345678 --no-extract
 *   bun apps/web/scripts/profile-company.ts --limit=20 --no-extract [--dry-run]
 *
 * --origin crawls any URL and persists NOTHING — the dev eyeball loop.
 * --company / --limit resolve crawl bases through the publishable gate and
 * persist snapshots; exactly what the future workflow calls.
 *
 * Env: POSTGRES_URL (not needed for --origin).
 */

import { createHash } from 'node:crypto';

import { createClient } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import type { CrawlDeps, CrawlResult } from '../src/lib/profiles/crawl.ts';
import { crawlOrigin } from '../src/lib/profiles/crawl.ts';
import {
  makeResolveCompanyUrl,
  makeSelectCrawlTargets,
  makeUpsertSnapshot,
} from '../src/lib/profiles/sql.ts';
import {
  looksChallenged,
  looksParked,
} from '../src/lib/websites/page-signals.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';
import { fetchPage, fetchSite } from './lib/web-fetch.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const originArg = flag('origin');
const companyArg = flag('company');
const limitArg = flag('limit');
const dryRun = args.includes('--dry-run');
/** Per-page detail and text previews, for a human at a terminal. */
const verbose = args.includes('--verbose');
const delayMs = parseStrictInt(flag('delay') ?? '250', 'delay');

if (!args.includes('--no-extract')) {
  console.error(
    '  extraction does not exist yet (plan step 4) — pass --no-extract',
  );
  process.exit(1);
}
const modes = [originArg, companyArg, limitArg].filter(Boolean).length;
if (modes !== 1) {
  console.error('  pass exactly one of --origin= | --company= | --limit=');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const deps: CrawlDeps = {
  fetchSite: async (url) => {
    const result = await fetchSite(url);
    return result.ok
      ? { ok: true, url: result.url, html: result.html }
      : { ok: false, reason: result.reason, status: result.status };
  },
  fetchPage: async (url) => {
    const result = await fetchPage(url);
    return result.ok
      ? { ok: true, url: result.url, html: result.html }
      : { ok: false, reason: result.reason, status: result.status };
  },
  hash: (text) => createHash('sha256').update(text).digest('hex'),
  looksParked,
  looksChallenged,
  sleep,
  log: (message) => console.log(message),
};

/** One-line-per-page report for a human; only ever printed under --origin or
 *  --verbose, never by the future workflow's default path. */
function printPages(result: CrawlResult): void {
  for (const page of result.pages) {
    const size = page.contentText ? `${page.contentText.length} chars` : '-';
    const detail = page.failure ? ` (${page.failure})` : '';
    console.log(
      `  ${page.path || '(home)'}  [${page.source}]  ${page.status}${detail}  ${size}`,
    );
    if (verbose && page.contentText) {
      console.log(`    ${page.contentText.slice(0, 240).replace(/\n/g, ' | ')}`);
    }
  }
  console.log(
    `  sitemap: ${result.sitemapFetches} fetches, ${result.sitemapPathsFound} candidate paths`,
  );
}

type Totals = Record<string, number>;

/** Fold one crawl into the aggregate counters the default output reports. */
function tally(totals: Totals, result: CrawlResult): void {
  for (const page of result.pages) {
    totals[`status:${page.status}`] = (totals[`status:${page.status}`] ?? 0) + 1;
    totals[`source:${page.source}`] = (totals[`source:${page.source}`] ?? 0) + 1;
  }
  totals.pages = (totals.pages ?? 0) + result.pages.length;
  totals.sitemapFetches = (totals.sitemapFetches ?? 0) + result.sitemapFetches;
}

if (originArg) {
  console.log(`Profile crawl (ad-hoc, nothing persisted): ${originArg}`);
  const result = await crawlOrigin(originArg, { delayMs }, deps);
  printPages(result);
  process.exit(0);
}

const db = createClient(process.env.POSTGRES_URL as string);
const upsert = makeUpsertSnapshot(db);

const targets = companyArg
  ? await (async () => {
      const url = await makeResolveCompanyUrl(db)(companyArg);
      if (!url) {
        console.error(`  no publishable website for company ${companyArg}`);
        process.exit(1);
      }
      return [{ url, companies: 1 }];
    })()
  : await makeSelectCrawlTargets(db)(parseStrictInt(limitArg ?? '0', 'limit'));

console.log(
  `Profile crawl — db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(`  targets: ${targets.length}  delay: ${delayMs}ms`);

const totals: Totals = {};
let written = 0;
for (const [index, target] of targets.entries()) {
  if (index > 0) await sleep(delayMs);
  const result = await crawlOrigin(target.url, { delayMs }, deps);
  tally(totals, result);
  if (verbose) {
    console.log(`${target.url} (${target.companies} companies)`);
    printPages(result);
  }
  if (!dryRun) {
    for (const page of result.pages) {
      await upsert(result.origin, page);
      written++;
    }
  }
}

console.log('Done.');
console.log(`  origins crawled: ${targets.length}`);
console.log(`  snapshots written: ${written}${dryRun ? ' (dry run: 0)' : ''}`);
for (const key of Object.keys(totals).sort()) {
  console.log(`  ${key}: ${totals[key]}`);
}
