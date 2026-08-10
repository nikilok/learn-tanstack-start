/**
 * Company-profiles harness — the CLI over the same lib modules the nightly
 * job will use. Step-4 shape: --origin crawls any URL, runs local Gemma over
 * the kept pages, prints the merged answers JSON, and persists NOTHING — the
 * dev/eyeball loop and the prompt-experiment instrument. Answer persistence
 * is step 5, so --company/--limit remain crawl-only for now.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/profile-company.ts --origin=https://example.co.uk [--verbose]
 *   bun apps/web/scripts/profile-company.ts --origin=https://example.co.uk --question="Who are their clients?"
 *   bun apps/web/scripts/profile-company.ts --origin=https://example.co.uk --no-extract
 *   bun apps/web/scripts/profile-company.ts --company=12345678 --no-extract
 *   bun apps/web/scripts/profile-company.ts --limit=20 --no-extract [--dry-run]
 *
 * Env: POSTGRES_URL (questions + persistence), GEMMA_* (model runtime).
 */

import { createHash } from 'node:crypto';

import { createClient } from '@ss/db/client';
import { MODEL_REVISION } from '@ss/gemma';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { truncateToTokenBudget } from '../src/lib/profiles/clean.ts';
import type { CrawlDeps, CrawlResult } from '../src/lib/profiles/crawl.ts';
import { crawlOrigin } from '../src/lib/profiles/crawl.ts';
import {
  assertAskFits,
  buildAskPrompt,
  parsePageAnswers,
  type ProfileQuestion,
  SYSTEM_PROMPT,
} from '../src/lib/profiles/extract.ts';
import {
  mergeAnswers,
  type MergedAnswer,
  type PageCandidate,
} from '../src/lib/profiles/merge.ts';
import {
  makeResolveCompanyUrl,
  makeSelectActiveQuestions,
  makeSelectCrawlTargets,
  makeUpsertSnapshot,
} from '../src/lib/profiles/sql.ts';
import {
  looksChallenged,
  looksParked,
} from '../src/lib/websites/page-signals.ts';
import {
  createPlaywrightGemmaClient,
  DEFAULT_GEMMA_MAX_TOKENS,
} from './lib/gemma-host-playwright.ts';
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
const questionArg = flag('question');
const noExtract = args.includes('--no-extract');
const dryRun = args.includes('--dry-run');
/** Per-page detail and text previews, for a human at a terminal. */
const verbose = args.includes('--verbose');
const delayMs = parseStrictInt(flag('delay') ?? '250', 'delay');

const modes = [originArg, companyArg, limitArg].filter(Boolean).length;
if (modes !== 1) {
  console.error('  pass exactly one of --origin= | --company= | --limit=');
  process.exit(1);
}
if (!originArg && !noExtract) {
  console.error(
    '  answer persistence lands in step 5 — pass --no-extract for crawl-only runs',
  );
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

/** The question set for this run: the live table, or one ad-hoc override. */
async function loadQuestions(): Promise<ProfileQuestion[]> {
  if (questionArg) {
    return [
      {
        slug: 'adhoc',
        prompt: questionArg,
        kind: 'prose',
        intent: 'Ad-hoc prompt experiment; persists nothing.',
        sort: 1,
      },
    ];
  }
  const questions = await makeSelectActiveQuestions(
    createClient(process.env.POSTGRES_URL as string),
  )();
  if (questions.length === 0) {
    console.error('  profile_questions has no active rows');
    process.exit(1);
  }
  return questions;
}

/** Map-reduce one crawl through Gemma: per-page asks, deterministic merge. */
async function extractAnswers(
  result: CrawlResult,
  questions: ProfileQuestion[],
): Promise<Record<string, MergedAnswer> | null> {
  // Identical content at two paths is one page to the model (4/20 origins in
  // the step-3 eyeball served duplicates).
  const seen = new Set<string>();
  const pages = result.pages.filter((page) => {
    if (page.status !== 'ok' || !page.contentText) return false;
    const key = page.contentHash ?? page.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (pages.length === 0) {
    console.log('  no readable pages — nothing to extract from');
    return null;
  }

  const contextTokens = process.env.GEMMA_MAX_TOKENS
    ? parseStrictInt(process.env.GEMMA_MAX_TOKENS, 'GEMMA_MAX_TOKENS')
    : DEFAULT_GEMMA_MAX_TOKENS;
  const budget = assertAskFits(questions, contextTokens);
  console.log(
    `  extract: ${pages.length} pages × ${questions.length} questions, page budget ${budget} tokens`,
  );

  const gemma = await createPlaywrightGemmaClient();
  try {
    const candidates: PageCandidate[] = [];
    for (const page of pages) {
      const prompt = buildAskPrompt(
        questions,
        page.url,
        truncateToTokenBudget(page.contentText as string, budget),
      );
      let response = await gemma.ask(prompt, SYSTEM_PROMPT);
      let parsed = parsePageAnswers(response.text, questions);
      if (!parsed.ok) {
        console.log(`  ${page.path || '(home)'}: retrying (${parsed.error})`);
        response = await gemma.ask(prompt, SYSTEM_PROMPT);
        parsed = parsePageAnswers(response.text, questions);
      }
      if (verbose) console.log(`  ${page.path || '(home)'}: ${response.stats}`);
      if (parsed.ok) {
        candidates.push({ path: page.path, url: page.url, answers: parsed.answers });
      } else {
        console.log(`  ${page.path || '(home)'}: failed (${parsed.error})`);
      }
    }
    return mergeAnswers(questions, candidates);
  } finally {
    await gemma.stop();
  }
}

if (originArg) {
  console.log(`Profile crawl (ad-hoc, nothing persisted): ${originArg}`);
  const result = await crawlOrigin(originArg, { delayMs }, deps);
  printPages(result);
  if (!noExtract) {
    const merged = await extractAnswers(result, await loadQuestions());
    if (merged) {
      console.log(
        JSON.stringify(
          {
            origin: result.origin,
            model: `gemma-4-E2B@${MODEL_REVISION.slice(0, 10)}`,
            answers: merged,
          },
          null,
          2,
        ),
      );
    }
  }
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
