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
import { basename } from 'node:path';

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
  makeReconcileOrigin,
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

/**
 * The model identity stamped onto every answer row — the ACTUAL weights, not
 * the pin. createPlaywrightGemmaClient resolves the model from GEMMA_MODEL_PATH
 * / GEMMA_MODEL_URL when either is set, so a run under an override extracts
 * with different weights than `MODEL_REVISION` names. Stamping the pin there
 * would record false provenance: the (question_hash, model) staleness key
 * would treat override-produced answers as fresh output of the pinned model,
 * and a later real pin bump would fail to mark exactly those rows stale. The
 * override marker keeps them distinct so they re-extract when the true pin runs.
 */
const modelPathOverride = process.env.GEMMA_MODEL_PATH?.trim();
const modelUrlOverride = process.env.GEMMA_MODEL_URL?.trim();
const MODEL_STAMP =
  modelPathOverride || modelUrlOverride
    ? `gemma-override:${(modelPathOverride ? basename(modelPathOverride) : 'url').slice(0, 48)}`
    : `gemma-4-E2B-it@${MODEL_REVISION}`;

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
const reconcileOrigin = makeReconcileOrigin(db);
const selectOkSnapshots = makeSelectOkSnapshots(db);

console.log(
  `Profile ${noExtract ? 'crawl' : fromSnapshots ? 'extract' : 'pipeline'} — db ${dbFingerprint(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);

/** Companies of one origin, with everything a write needs. */
type OriginGroup = {
  origin: string;
  urls: string[];
  companies: { companyNumber: string; evidence: string }[];
};

const totals: Totals = {};
const startedAt = Date.now();

/** Group a company list by its unit of work, the origin — franchise subtrees
 *  on one domain travel together so a single crawl + reconcile covers them. */
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

/**
 * Crawl every url of a group, persist snapshots (the upsert guards preserve ok
 * text and manual rows), and reconcile the origin down to the pages this crawl
 * kept — only when the crawl actually read the site. Persist-only; extraction
 * reads the corpus back from the store. The returned in-memory pages are used
 * only by --dry-run, which persists nothing to read back.
 */
async function crawlGroup(group: OriginGroup): Promise<AskablePage[]> {
  const inMemory: AskablePage[] = [];
  const keptPaths: string[] = [];
  let everyUrlReadable = true;
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
        keptPaths.push(page.path);
        totals.snapshotsWritten = (totals.snapshotsWritten ?? 0) + 1;
      }
    }
    const readable = askablePages(result);
    if (readable.length === 0) everyUrlReadable = false;
    inMemory.push(...readable);
    await sleep(delayMs);
  }
  // Prune only when every url of the group read pages: a blocked or erroring
  // crawl still returns failure-row paths, so a non-empty kept-set does NOT
  // prove the frontier was real — reconciling to it would delete the stored
  // corpus the upsert guard just preserved.
  if (!dryRun && everyUrlReadable) {
    const pruned = await reconcileOrigin(group.origin, keptPaths);
    if (pruned) totals.snapshotsPruned = (totals.snapshotsPruned ?? 0) + pruned;
  }
  return inMemory;
}

/**
 * The pages one origin's extraction reads. --from-snapshots and the persisting
 * combined mode both extract from the STORED corpus, so manual rows and any ok
 * text preserved across a failed re-crawl are included and a transient
 * unreadable crawl can't feed extraction an empty page set that regresses good
 * answers. --dry-run has nothing persisted to read back, so it uses the
 * in-memory crawl.
 */
async function pagesForExtraction(group: OriginGroup): Promise<AskablePage[]> {
  if (fromSnapshots) return selectOkSnapshots(group.origin);
  const inMemory = await crawlGroup(group);
  return dryRun ? inMemory : selectOkSnapshots(group.origin);
}

/** Consecutive origins whose extraction throws before the run aborts: a wedged
 *  engine (WebGPU device lost, page crash) fails every ask, so churning on
 *  would burn the whole window writing nothing. */
const SYSTEMIC_FAILURE_STREAK = 5;

if (noExtract) {
  // Crawl sweep: snapshots only. Origin groups (not per-url) so franchise
  // subtrees on one domain crawl together and reconcile once — per-url
  // reconciliation would delete each other's pages.
  let groups: OriginGroup[];
  if (companyArg) {
    const website = await makeResolveCompanyWebsite(db)(companyArg);
    if (!website) {
      console.error(`  no publishable website for company ${companyArg}`);
      process.exit(1);
    }
    groups = [{ origin: snapshotOrigin(website.url), urls: [website.url], companies: [] }];
  } else if (companiesFileArg) {
    const resolved = await makeResolveCompanyWebsites(db)(
      await readCompaniesFile(companiesFileArg),
    );
    groups = groupByOrigin(resolved);
  } else {
    const targets = await makeSelectCrawlTargets(db)(
      parseStrictInt(limitArg ?? '0', 'limit'),
    );
    const byOrigin = new Map<string, OriginGroup>();
    for (const target of targets) {
      const origin = snapshotOrigin(target.url);
      const group = byOrigin.get(origin) ?? { origin, urls: [], companies: [] };
      if (!group.urls.includes(target.url)) group.urls.push(target.url);
      byOrigin.set(origin, group);
    }
    groups = [...byOrigin.values()];
  }
  console.log(`  origins: ${groups.length}  delay: ${delayMs}ms`);
  for (const group of groups) await crawlGroup(group);
} else {
  // Extraction modes: one extraction per origin serves every company on it.
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
      console.log(`  invalidated ${invalidated} answers of demoted companies`);
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
        companies: [{ companyNumber: companyArg, evidence: website.evidence }],
      },
    ];
  } else if (companiesFileArg) {
    // The pilot path: an explicit (stratified) company list, no cap.
    const numbers = await readCompaniesFile(companiesFileArg);
    const resolved = await makeResolveCompanyWebsites(db)(numbers);
    if (resolved.length < numbers.length) {
      console.log(
        `  ${numbers.length - resolved.length} of ${numbers.length} listed companies have no publishable website; skipped`,
      );
    }
    groups = groupByOrigin(resolved);
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
  }

  // Shared across every extraction mode: --from-snapshots serves ONLY origins
  // the crawl sweep has stored, so a never-crawled origin is never written as
  // insufficient_content — it's simply not fetched yet.
  if (fromSnapshots) {
    const crawled = await makeSelectSnapshotOrigins(db)();
    const before = groups.length;
    groups = groups.filter((group) => crawled.has(group.origin));
    const dropped = before - groups.length;
    if (dropped) {
      console.log(`  ${dropped} origins not yet crawled; run the crawl sweep first`);
    }
  }

  // The due path caps to --limit origins; explicit modes take the whole list.
  if (!companyArg && !companiesFileArg) {
    groups = groups.slice(0, parseStrictInt(limitArg ?? '0', 'limit'));
  }

  const contextTokens = process.env.GEMMA_MAX_TOKENS
    ? parseStrictInt(process.env.GEMMA_MAX_TOKENS, 'GEMMA_MAX_TOKENS')
    : DEFAULT_GEMMA_MAX_TOKENS;
  const budget = assertAskFits(questions, contextTokens);
  console.log(
    `  origins: ${groups.length}  questions: ${questions.length}  page budget: ${budget} tokens  model: ${MODEL_STAMP}`,
  );

  if (groups.length > 0) {
    const gemma = await createPlaywrightGemmaClient();
    let failureStreak = 0;
    try {
      for (const group of groups) {
        const pages = await pagesForExtraction(group);
        let outcome: ExtractionOutcome;
        try {
          outcome = await extractOutcome(gemma, pages, questions, budget);
          failureStreak = 0;
        } catch (err) {
          // A wedged generation must not crash the sweep. Leave the origin
          // unwritten — immediately retryable, an infra blip rather than a
          // model verdict — and escalate if it keeps happening.
          const message = err instanceof Error ? err.message : String(err);
          console.log(`  ${group.origin}: extraction failed, left due — ${message}`);
          failureStreak++;
          totals.extractionFailures = (totals.extractionFailures ?? 0) + 1;
          if (failureStreak >= SYSTEMIC_FAILURE_STREAK) {
            console.error(
              `  aborting: ${failureStreak} consecutive extraction failures (engine wedged?)`,
            );
            break;
          }
          continue;
        }
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
