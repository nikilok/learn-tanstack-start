/**
 * Company-profiles harness — the complete pilot instrument, and the exact
 * behaviors the CI sweeps call: crawl-only (`--no-extract`, the ubuntu crawl
 * sweep), extract-only (`--from-snapshots`, the macOS Gemma sweep — touches
 * no third-party site), and combined (bare, the local-backfill mode that
 * boots Gemma once and does both).
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/profile-company.ts --origin=https://example.co.uk [--verbose]
 *   bun apps/web/scripts/profile-company.ts --origin=https://example.co.uk --question="Who are their clients?"
 *   bun apps/web/scripts/profile-company.ts --company=12345678 [--no-extract | --from-snapshots]
 *   bun apps/web/scripts/profile-company.ts --limit=20 --no-extract        # crawl sweep
 *   bun apps/web/scripts/profile-company.ts --limit=20 --from-snapshots    # extract sweep
 *   bun apps/web/scripts/profile-company.ts --limit=20                     # local backfill
 *
 * --origin persists NOTHING. --limit counts origins. --dry-run skips every
 * write. Answers stamp question_hash + model, so re-runs skip fresh rows and
 * a prompt edit or pin bump re-extracts rolling from stored snapshots.
 *
 * Env: POSTGRES_URL, GEMMA_* (model runtime).
 */

import { createHash } from 'node:crypto';

import { createClient } from '@ss/db/client';
import { MODEL_REVISION } from '@ss/gemma';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import {
  answerRows,
  type ExtractionOutcome,
} from '../src/lib/profiles/answers.ts';
import { truncateToTokenBudget } from '../src/lib/profiles/clean.ts';
import type { CrawlDeps, CrawlResult } from '../src/lib/profiles/crawl.ts';
import { crawlOrigin, snapshotOrigin } from '../src/lib/profiles/crawl.ts';
import {
  askHashInput,
  assertAskFits,
  buildAskPrompt,
  parsePageAnswers,
  type ProfileQuestion,
  SYSTEM_PROMPT,
} from '../src/lib/profiles/extract.ts';
import { mergeAnswers, type PageCandidate } from '../src/lib/profiles/merge.ts';
import {
  type DueCompany,
  makeInvalidateOrphanedAnswers,
  makeResolveCompanyWebsite,
  makeResolveCompanyWebsites,
  makeSelectActiveQuestions,
  makeSelectCrawlTargets,
  makeSelectDueCompanies,
  makeSelectOkSnapshots,
  makeSelectSnapshotOrigins,
  makeUpsertAnswers,
  makeUpsertSnapshot,
} from '../src/lib/profiles/sql.ts';
import {
  looksChallenged,
  looksParked,
} from '../src/lib/websites/page-signals.ts';
import type { GemmaClient } from '@ss/gemma';
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
const shardArg = flag('shard');
const companiesFileArg = flag('companies-file');
const noExtract = args.includes('--no-extract');
const fromSnapshots = args.includes('--from-snapshots');
const dryRun = args.includes('--dry-run');
/** Per-page detail and text previews, for a human at a terminal. */
const verbose = args.includes('--verbose');
const delayMs = parseStrictInt(flag('delay') ?? '250', 'delay');

const modes = [originArg, companyArg, limitArg, companiesFileArg].filter(
  Boolean,
).length;
if (modes !== 1) {
  console.error(
    '  pass exactly one of --origin= | --company= | --limit= | --companies-file=',
  );
  process.exit(1);
}

/** Company numbers from an explicit list file: one per line, # comments. */
async function readCompaniesFile(path: string): Promise<string[]> {
  const body = await Bun.file(path).text();
  const numbers = body
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  if (numbers.length === 0) {
    console.error(`  ${path} holds no company numbers`);
    process.exit(1);
  }
  return numbers;
}
if (noExtract && fromSnapshots) {
  console.error('  --no-extract and --from-snapshots contradict each other');
  process.exit(1);
}
if (questionArg && !originArg) {
  console.error(
    '  --question is the ephemeral experiment flag; it only runs with --origin and never persists',
  );
  process.exit(1);
}

/**
 * Deterministic work partition for concurrent extraction workers: an origin
 * belongs to bucket hash(origin) % N, permanently, on every machine —
 * disjoint inputs by arithmetic, so no claims table and no coordination.
 * Progress within a shard is the staleness predicate itself: done work stops
 * being due. Null when unset (the whole population).
 */
const shard = ((): { bucket: number; of: number } | null => {
  if (!shardArg) return null;
  const match = /^(\d+)\/(\d+)$/.exec(shardArg);
  const bucket = match ? Number(match[1]) : Number.NaN;
  const of = match ? Number(match[2]) : Number.NaN;
  if (!match || of < 2 || bucket >= of) {
    console.error('  --shard must be K/N with 0 <= K < N and N >= 2');
    process.exit(1);
  }
  if (!limitArg || noExtract) {
    console.error(
      '  --shard partitions extraction batches; it needs --limit without --no-extract',
    );
    process.exit(1);
  }
  return { bucket, of };
})();

/** FNV-1a over the origin: stable across runs and machines. */
function shardBucket(origin: string, of: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < origin.length; i++) {
    hash ^= origin.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % of;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/** The model identity stamped onto every answer row this run writes. */
const MODEL_STAMP = `gemma-4-E2B-it@${MODEL_REVISION}`;

let dbHandle: ReturnType<typeof createClient> | undefined;
const getDb = () => {
  dbHandle ??= createClient(process.env.POSTGRES_URL as string);
  return dbHandle;
};

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
  hash: sha256,
  looksParked,
  looksChallenged,
  sleep,
  log: (message) => console.log(message),
};

/** One-line-per-page report for a human; only ever printed under --origin or
 *  --verbose, never by a workflow's default path. */
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
  const questions = await makeSelectActiveQuestions(getDb())();
  if (questions.length === 0) {
    console.error('  profile_questions has no active rows');
    process.exit(1);
  }
  return questions;
}

/** A page the ask loop can read, whichever store it came from. */
type AskablePage = {
  path: string;
  url: string;
  contentText: string;
  contentHash: string | null;
};

/** Identical content at two paths is one page to the model. */
function dedupeByHash(pages: AskablePage[]): AskablePage[] {
  const seen = new Set<string>();
  return pages.filter((page) => {
    const key = page.contentHash ?? page.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Map-reduce one origin's pages through Gemma into an extraction outcome. */
async function extractOutcome(
  gemma: GemmaClient,
  pages: AskablePage[],
  questions: ProfileQuestion[],
  budget: number,
): Promise<ExtractionOutcome> {
  const deduped = dedupeByHash(pages);
  if (deduped.length === 0) return { kind: 'no_readable_pages' };
  const candidates: PageCandidate[] = [];
  for (const page of deduped) {
    const prompt = buildAskPrompt(
      questions,
      page.url,
      truncateToTokenBudget(page.contentText, budget),
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
      candidates.push({
        path: page.path,
        url: page.url,
        answers: parsed.answers,
      });
    } else {
      console.log(`  ${page.path || '(home)'}: failed (${parsed.error})`);
    }
  }
  if (candidates.length === 0) return { kind: 'model_failure' };
  return { kind: 'merged', merged: mergeAnswers(questions, candidates) };
}

/** Ok pages of a crawl result, as askable pages. */
function askablePages(result: CrawlResult): AskablePage[] {
  return result.pages.flatMap((page) =>
    page.status === 'ok' && page.contentText
      ? [
          {
            path: page.path,
            url: page.url,
            contentText: page.contentText,
            contentHash: page.contentHash,
          },
        ]
      : [],
  );
}

// ─── --origin: the ad-hoc loop; persists nothing ─────────────────────────────

if (originArg) {
  let pages: AskablePage[];
  if (fromSnapshots) {
    const origin = snapshotOrigin(originArg);
    pages = await makeSelectOkSnapshots(getDb())(origin);
    console.log(
      `Profile extract (ad-hoc, nothing persisted): ${origin} — ${pages.length} stored pages`,
    );
  } else {
    console.log(`Profile crawl (ad-hoc, nothing persisted): ${originArg}`);
    const result = await crawlOrigin(originArg, { delayMs }, deps);
    printPages(result);
    pages = askablePages(result);
  }
  if (!noExtract) {
    const questions = await loadQuestions();
    const contextTokens = process.env.GEMMA_MAX_TOKENS
      ? parseStrictInt(process.env.GEMMA_MAX_TOKENS, 'GEMMA_MAX_TOKENS')
      : DEFAULT_GEMMA_MAX_TOKENS;
    const budget = assertAskFits(questions, contextTokens);
    console.log(
      `  extract: ${pages.length} pages × ${questions.length} questions, page budget ${budget} tokens`,
    );
    const gemma = await createPlaywrightGemmaClient();
    try {
      const outcome = await extractOutcome(gemma, pages, questions, budget);
      console.log(
        JSON.stringify(
          {
            origin: snapshotOrigin(originArg),
            model: MODEL_STAMP,
            outcome:
              outcome.kind === 'merged'
                ? { kind: outcome.kind, answers: outcome.merged }
                : outcome,
          },
          null,
          2,
        ),
      );
    } finally {
      await gemma.stop();
    }
  }
  process.exit(0);
}

// ─── persisting modes ────────────────────────────────────────────────────────

const db = getDb();
const upsertSnapshot = makeUpsertSnapshot(db);
const upsertAnswers = makeUpsertAnswers(db);

console.log(
  `Profile ${noExtract ? 'crawl' : fromSnapshots ? 'extract' : 'pipeline'} — db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);

/** Companies of one origin, with everything a write needs. */
type OriginGroup = {
  origin: string;
  urls: string[];
  companies: { companyNumber: string; evidence: string }[];
};

/** Crawl one group's url(s), persist snapshots, return the askable pages. */
async function crawlGroup(
  group: OriginGroup,
  totals: Totals,
): Promise<AskablePage[]> {
  const pages: AskablePage[] = [];
  for (const url of group.urls) {
    const result = await crawlOrigin(url, { delayMs }, deps);
    tally(totals, result);
    if (verbose) {
      console.log(`${url} (${group.companies.length} companies)`);
      printPages(result);
    }
    if (!dryRun) {
      for (const page of result.pages) {
        await upsertSnapshot(result.origin, page);
        totals.snapshotsWritten = (totals.snapshotsWritten ?? 0) + 1;
      }
    }
    pages.push(...askablePages(result));
    await sleep(delayMs);
  }
  return pages;
}

const totals: Totals = {};
const startedAt = Date.now();

/** Group an explicit or due company list by its unit of work, the origin. */
function groupByOrigin(companies: DueCompany[]): OriginGroup[] {
  const byOrigin = new Map<string, OriginGroup>();
  for (const company of companies) {
    const origin = snapshotOrigin(company.url);
    const group = byOrigin.get(origin) ?? { origin, urls: [], companies: [] };
    if (!group.urls.includes(company.url)) group.urls.push(company.url);
    group.companies.push({
      companyNumber: company.companyNumber,
      evidence: company.evidence,
    });
    byOrigin.set(origin, group);
  }
  return [...byOrigin.values()];
}

if (noExtract) {
  // Crawl sweep: snapshots only, selection ordered never-crawled first.
  let targets: { url: string; companies: number }[];
  if (companyArg) {
    const website = await makeResolveCompanyWebsite(db)(companyArg);
    if (!website) {
      console.error(`  no publishable website for company ${companyArg}`);
      process.exit(1);
    }
    targets = [{ url: website.url, companies: 1 }];
  } else if (companiesFileArg) {
    const resolved = await makeResolveCompanyWebsites(db)(
      await readCompaniesFile(companiesFileArg),
    );
    targets = groupByOrigin(resolved).map((group) => ({
      url: group.urls[0],
      companies: group.companies.length,
    }));
  } else {
    targets = await makeSelectCrawlTargets(db)(
      parseStrictInt(limitArg ?? '0', 'limit'),
    );
  }
  console.log(`  targets: ${targets.length}  delay: ${delayMs}ms`);
  for (const target of targets) {
    await crawlGroup(
      {
        origin: snapshotOrigin(target.url),
        urls: [target.url],
        companies: [],
      },
      totals,
    );
  }
} else {
  // Extraction modes: group due companies by origin, one extraction serves
  // every company on the domain.
  const questions = await loadQuestions();
  const hashes = new Map(
    questions.map((question) => [question.slug, sha256(askHashInput(question))]),
  );
  const hashPairs = questions.map((question) => ({
    slug: question.slug,
    hash: hashes.get(question.slug) as string,
  }));

  if (!dryRun) {
    const invalidated = await makeInvalidateOrphanedAnswers(db)();
    if (invalidated > 0) {
      console.log(`  invalidated ${invalidated} answers of unpublishable companies`);
    }
  }

  let groups: OriginGroup[];
  if (companyArg) {
    const website = await makeResolveCompanyWebsite(db)(companyArg);
    if (!website) {
      console.error(`  no publishable website for company ${companyArg}`);
      process.exit(1);
    }
    groups = [
      {
        origin: snapshotOrigin(website.url),
        urls: [website.url],
        companies: [
          { companyNumber: companyArg, evidence: website.evidence },
        ],
      },
    ];
  } else if (companiesFileArg) {
    // The pilot path: an explicit (stratified) company list through the
    // exact pipeline, no due-ordering, no cap.
    const numbers = await readCompaniesFile(companiesFileArg);
    const resolved = await makeResolveCompanyWebsites(db)(numbers);
    if (resolved.length < numbers.length) {
      console.log(
        `  ${numbers.length - resolved.length} of ${numbers.length} listed companies have no publishable website; skipped`,
      );
    }
    groups = groupByOrigin(resolved);
    if (fromSnapshots) {
      const crawled = await makeSelectSnapshotOrigins(db)();
      groups = groups.filter((group) => crawled.has(group.origin));
    }
  } else {
    const due = await makeSelectDueCompanies(db)(hashPairs, MODEL_STAMP);
    groups = groupByOrigin(due);
    if (shard) {
      // The origin is the unit of work, so it is also the unit of sharding —
      // companies sharing a domain always travel to the same worker.
      groups = groups.filter(
        (group) => shardBucket(group.origin, shard.of) === shard.bucket,
      );
      console.log(
        `  shard ${shard.bucket}/${shard.of}: ${groups.length} due origins in this bucket`,
      );
    }
    if (fromSnapshots) {
      // The extract sweep serves only what the crawl sweep has stored.
      const crawled = await makeSelectSnapshotOrigins(db)();
      groups = groups.filter((group) => crawled.has(group.origin));
    }
    groups = groups.slice(0, parseStrictInt(limitArg ?? '0', 'limit'));
  }

  const contextTokens = process.env.GEMMA_MAX_TOKENS
    ? parseStrictInt(process.env.GEMMA_MAX_TOKENS, 'GEMMA_MAX_TOKENS')
    : DEFAULT_GEMMA_MAX_TOKENS;
  const budget = assertAskFits(questions, contextTokens);
  console.log(
    `  origins: ${groups.length}  questions: ${questions.length}  page budget: ${budget} tokens`,
  );

  if (groups.length > 0) {
    const selectOkSnapshots = makeSelectOkSnapshots(db);
    const gemma = await createPlaywrightGemmaClient();
    try {
      for (const group of groups) {
        const pages = fromSnapshots
          ? await selectOkSnapshots(group.origin)
          : await crawlGroup(group, totals);
        const outcome = await extractOutcome(gemma, pages, questions, budget);
        for (const company of group.companies) {
          const rows = answerRows(company.companyNumber, questions, outcome, {
            hashes,
            model: MODEL_STAMP,
            identityEvidence: company.evidence,
          });
          if (!dryRun) await upsertAnswers(rows);
          for (const row of rows) {
            const key = `answer:${row.questionSlug}:${row.status}`;
            totals[key] = (totals[key] ?? 0) + 1;
            totals.answers = (totals.answers ?? 0) + 1;
          }
          totals.companies = (totals.companies ?? 0) + 1;
        }
        totals.origins = (totals.origins ?? 0) + 1;
      }
    } finally {
      await gemma.stop();
    }
  }
}

const seconds = (Date.now() - startedAt) / 1000;
console.log('Done.');
for (const key of Object.keys(totals).sort()) {
  console.log(`  ${key}: ${totals[key]}`);
}
if (totals.answers) {
  const insufficient = Object.entries(totals)
    .filter(([key]) => key.endsWith(':insufficient_content'))
    .reduce((sum, [, count]) => sum + count, 0);
  console.log(
    `  insufficient rate: ${((insufficient / totals.answers) * 100).toFixed(1)}%`,
  );
}
if (totals.origins) {
  console.log(`  seconds/origin: ${(seconds / totals.origins).toFixed(1)}`);
}
