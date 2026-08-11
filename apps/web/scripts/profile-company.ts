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
 *   bun apps/web/scripts/profile-company.ts --limit=50 --from-snapshots --claim=mac-1
 *   bun profiles:work                       # fleet worker, from any machine
 *
 * --work (the root `profiles:work` script) is sugar for the fleet defaults:
 * --from-snapshots + --claim=<hostname> + --limit=100, each yielding to an
 * explicit flag.
 *
 * --origin persists NOTHING. --limit counts origins. --dry-run skips every
 * write. Answers stamp question_hash + model, so re-runs skip fresh rows and
 * a prompt edit or pin bump re-extracts rolling from stored snapshots.
 * --claim=<worker-id> lets concurrent workers share one due list through
 * profile_work_claims: each origin is won by exactly one worker, released on
 * completion, and --limit becomes that worker's win target. Claims are taken
 * for real even under --dry-run (coordination must be observable); answers
 * and snapshots stay unwritten — which means a dry-run rehearsal DISPLACES
 * live workers for its window. Never overlap one with a scheduled sweep.
 *
 * Env: POSTGRES_URL, GEMMA_* (model runtime).
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';

import { createClient } from '@ss/db/client';
import { MODEL_REVISION } from '@ss/gemma';
import type { GemmaAskResult, GemmaClient } from '@ss/gemma';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import {
  answerRows,
  type ExtractionOutcome,
} from '../src/lib/profiles/answers.ts';
import {
  makeClaimOrigins,
  makeReleaseClaims,
  makeRenewClaims,
} from '../src/lib/profiles/claims.ts';
import { truncateToTokenBudget } from '../src/lib/profiles/clean.ts';
import type { CrawlDeps, CrawlResult } from '../src/lib/profiles/crawl.ts';
import { crawlOrigin, snapshotOrigin } from '../src/lib/profiles/crawl.ts';
import {
  askHashInput,
  assertAskFits,
  buildAskPrompt,
  MAX_OVERFLOW_SHRINKS,
  MIN_PAGE_BUDGET_TOKENS,
  overflowRetryBudget,
  parsePageAnswers,
  parseTokenOverflow,
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
  insufficientCount,
  renderRunSummary,
} from '../src/lib/profiles/summary.ts';
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
const questionArg = flag('question');
const companiesFileArg = flag('companies-file');
const noExtract = args.includes('--no-extract');
const dryRun = args.includes('--dry-run');
/** Per-page detail and text previews, for a human at a terminal. */
const verbose = args.includes('--verbose');
const delayMs = parseStrictInt(flag('delay') ?? '250', 'delay');

/**
 * --work is the fleet entry point (the root `profiles:work` script): any
 * trusted machine latches into the shared due list with one command. Pure
 * sugar over the explicit flags — extract-only, hostname claim identity, a
 * bounded default chunk — and every default yields to an explicit flag, so
 * everything downstream sees only effective values and there is no second
 * code path.
 */
const workMode = args.includes('--work');
const limitArg = flag('limit') ?? (workMode ? '100' : undefined);
const claimArg =
  flag('claim') ?? (workMode ? hostname().slice(0, 40) : undefined);
const fromSnapshots = args.includes('--from-snapshots') || workMode;

// Reject anything unrecognized: a mistyped or removed flag (--shard, --claim
// without '=') silently degrading to an uncoordinated run is how two workers
// end up double-extracting a whole sweep.
const KNOWN_ARGS =
  /^--(origin|company|limit|question|claim|companies-file|delay)=|^--(no-extract|from-snapshots|dry-run|verbose|work)$/;
const unknownArgs = args.filter((arg) => !KNOWN_ARGS.test(arg));
if (unknownArgs.length > 0) {
  const shardHint = unknownArgs.some((arg) => arg.startsWith('--shard'))
    ? ' (--shard was removed; concurrent workers coordinate via --claim)'
    : '';
  console.error(
    `  unrecognized argument(s): ${unknownArgs.join(' ')}${shardHint}`,
  );
  process.exit(1);
}

if (workMode && (originArg || companyArg || companiesFileArg)) {
  console.error(
    '  --work drains the shared due list; drop --origin/--company/--companies-file',
  );
  process.exit(1);
}
if (workMode && noExtract) {
  console.error('  --work is extract-only; the crawl sweep runs from CI alone');
  process.exit(1);
}

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
 * Worker identity for claim-coordinated extraction: concurrent workers (CI,
 * local Mac, any GPU box) share one due list, and profile_work_claims hands
 * each origin to exactly one of them. No pre-partitioning — a fast worker
 * simply claims more. Null when unset (single-worker run, plain --limit cap).
 */
const claimWorker = ((): string | null => {
  if (claimArg === undefined) return null;
  if (!/^\S{1,40}$/.test(claimArg)) {
    console.error('  --claim needs a worker id: 1-40 chars, no whitespace');
    process.exit(1);
  }
  if (!limitArg || noExtract) {
    console.error(
      '  --claim coordinates extraction batches; it needs --limit without --no-extract',
    );
    process.exit(1);
  }
  if (parseStrictInt(limitArg, 'limit') === 0) {
    console.error('  --claim needs a positive --limit win target');
    process.exit(1);
  }
  return claimArg;
})();

/**
 * Per-process claim identity: the operator id salted with pid + start time.
 * Two incarnations sharing --claim=id (a retry racing its hung predecessor)
 * must never pass each other's claimed_by guard, so claims, renewals and
 * releases all key on the instance. The deliberate cost: a restarted worker
 * cannot instantly reclaim its predecessor's orphans — they wait out the
 * lease, bounded at one CLAIM_BATCH — chosen over same-id reclamation, which
 * would let two live same-id processes delete each other's active claims.
 */
const claimInstance = claimWorker
  ? `${claimWorker}.${process.pid.toString(36)}.${Date.now().toString(36)}`
  : null;

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
      console.log(
        `    ${page.contentText.slice(0, 240).replace(/\n/g, ' | ')}`,
      );
    }
  }
  console.log(
    `  sitemap: ${result.sitemapFetches} fetches, ${result.sitemapPathsFound} candidate paths`,
  );
}

type Totals = Record<string, number>;

const totals: Totals = {};

/** Fold one crawl into the aggregate counters the default output reports. */
function tally(totals: Totals, result: CrawlResult): void {
  for (const page of result.pages) {
    totals[`status:${page.status}`] =
      (totals[`status:${page.status}`] ?? 0) + 1;
    totals[`source:${page.source}`] =
      (totals[`source:${page.source}`] ?? 0) + 1;
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

/** One page's ask, shrinking the text budget when the real tokenizer overflows. */
async function askFittingWindow(
  gemma: GemmaClient,
  questions: ProfileQuestion[],
  page: AskablePage,
  budget: number,
  totals: Totals,
): Promise<{ prompt: string; response: GemmaAskResult }> {
  let pageBudget = budget;
  for (let shrinks = 0; ; shrinks += 1) {
    const prompt = buildAskPrompt(
      questions,
      page.url,
      truncateToTokenBudget(page.contentText, pageBudget),
    );
    try {
      return { prompt, response: await gemma.ask(prompt, SYSTEM_PROMPT) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const overflow = parseTokenOverflow(message);
      if (!overflow || shrinks >= MAX_OVERFLOW_SHRINKS) throw error;
      const next = overflowRetryBudget(
        pageBudget,
        page.contentText,
        overflow.actual,
        overflow.allowed,
      );
      if (next < MIN_PAGE_BUDGET_TOKENS) throw error;
      totals.askOverflowShrinks = (totals.askOverflowShrinks ?? 0) + 1;
      console.log(
        `  ${page.path || '(home)'}: window overflow (${overflow.actual} real tokens), retrying at ${next}-token budget`,
      );
      pageBudget = next;
    }
  }
}

/** Map-reduce one origin's pages through Gemma into an extraction outcome. */
async function extractOutcome(
  gemma: GemmaClient,
  pages: AskablePage[],
  questions: ProfileQuestion[],
  budget: number,
  totals: Totals,
): Promise<ExtractionOutcome> {
  const deduped = dedupeByHash(pages);
  if (deduped.length === 0) return { kind: 'no_readable_pages' };
  const candidates: PageCandidate[] = [];
  for (const page of deduped) {
    const { prompt, response: first } = await askFittingWindow(
      gemma,
      questions,
      page,
      budget,
      totals,
    );
    let response = first;
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
      const outcome = await extractOutcome(gemma, pages, questions, budget, {});
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

const modeLabel = `Profile ${noExtract ? 'crawl' : fromSnapshots ? 'extract' : 'pipeline'}${dryRun ? ' (DRY RUN)' : ''}`;
console.log(`${modeLabel} — db ${dbFingerprint(process.env.POSTGRES_URL)}`);

/** Companies of one origin, with everything a write needs. */
type OriginGroup = {
  origin: string;
  urls: string[];
  companies: { companyNumber: string; evidence: string }[];
};

const startedAt = Date.now();

/** Group a company list by its unit of work, the origin — franchise subtrees
 *  on one domain travel together so a single crawl + reconcile covers them. */
/** Origin for a stored url, failing loudly on a malformed value — a scripted
 *  single-company call deserves a clean message, not a TypeError. */
function requireOrigin(url: string, companyNumber: string): string {
  try {
    return snapshotOrigin(url);
  } catch {
    console.error(
      `  malformed stored website url for company ${companyNumber}`,
    );
    process.exit(1);
  }
}

function groupByOrigin(companies: DueCompany[]): OriginGroup[] {
  const byOrigin = new Map<string, OriginGroup>();
  for (const company of companies) {
    let origin: string;
    try {
      origin = snapshotOrigin(company.url);
    } catch {
      console.log(
        `  skipping malformed website url for ${company.companyNumber}`,
      );
      continue;
    }
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

/** Origins claimed per round in a --claim run. Batch size trades claim-table
 *  round-trips against how long a lost peer's origins wait; the lease is kept
 *  alive by per-origin renewal, not by batch duration. */
const CLAIM_BATCH = 8;

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
    groups = [
      {
        origin: requireOrigin(website.url, companyArg),
        urls: [website.url],
        companies: [],
      },
    ];
  } else if (companiesFileArg) {
    const resolved = await makeResolveCompanyWebsites(db)(
      await readCompaniesFile(companiesFileArg),
    );
    groups = groupByOrigin(resolved);
  } else {
    // Targets arrive origin-planned: one rotation slot per origin, every
    // subtree url included, so a group can never be split by the limit.
    const targets = await makeSelectCrawlTargets(db)(
      parseStrictInt(limitArg ?? '0', 'limit'),
    );
    groups = targets.map((target) => ({
      origin: target.origin,
      urls: target.urls,
      companies: [],
    }));
  }
  console.log(`  origins: ${groups.length}  delay: ${delayMs}ms`);
  // The same per-origin tolerance the extraction loop has: one transient DB
  // or network error must not discard the rest of the night's rotation.
  let crawlStreak = 0;
  for (const group of groups) {
    try {
      await crawlGroup(group);
      crawlStreak = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `  ${group.origin}: crawl failed, left in rotation — ${message}`,
      );
      crawlStreak++;
      totals.crawlFailures = (totals.crawlFailures ?? 0) + 1;
      if (crawlStreak >= SYSTEMIC_FAILURE_STREAK) {
        console.error(
          `  aborting: ${crawlStreak} consecutive crawl failures (network or db down?)`,
        );
        process.exitCode = 1;
        break;
      }
    }
  }
} else {
  // Extraction modes: one extraction per origin serves every company on it.
  const questions = await loadQuestions();
  const hashes = new Map(
    questions.map((question) => [
      question.slug,
      sha256(askHashInput(question)),
    ]),
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
        origin: requireOrigin(website.url, companyArg),
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
      console.log(
        `  ${dropped} origins not yet crawled; run the crawl sweep first`,
      );
    }
  }

  // The due path caps to --limit origins; explicit modes take the whole list.
  // A claim run keeps the full list: --limit becomes the number of origins to
  // WIN, and the claim loop walks as far as it must to win them.
  const dueLimit = parseStrictInt(limitArg ?? '0', 'limit');
  if (!companyArg && !companiesFileArg && !claimWorker) {
    groups = groups.slice(0, dueLimit);
  }

  const contextTokens = process.env.GEMMA_MAX_TOKENS
    ? parseStrictInt(process.env.GEMMA_MAX_TOKENS, 'GEMMA_MAX_TOKENS')
    : DEFAULT_GEMMA_MAX_TOKENS;
  const budget = assertAskFits(questions, contextTokens);
  console.log(
    `  origins: ${groups.length}  questions: ${questions.length}  page budget: ${budget} tokens  model: ${MODEL_STAMP}${claimInstance ? `  claim: ${claimInstance} (target ${dueLimit})` : ''}`,
  );

  if (groups.length > 0) {
    // Booted on first real work, not on selection: a claim worker that wins
    // nothing (a faster peer drained the tail) must not pay the engine boot.
    let gemma: GemmaClient | undefined;
    const ensureGemma = async (): Promise<GemmaClient> =>
      (gemma ??= await createPlaywrightGemmaClient());
    let failureStreak = 0;

    /** Extract + write one origin group. False = abort the run (engine wedged). */
    const processGroup = async (group: OriginGroup): Promise<boolean> => {
      try {
        // Page loading, the asks AND the answer writes all sit under one
        // per-origin tolerance: a transient DB error on a write is an infra
        // blip like any other and must not discard the rest of the run. The
        // streak resets only after the writes land, so a systemic outage on
        // any stage escalates.
        const pages = await pagesForExtraction(group);
        const outcome = await extractOutcome(
          await ensureGemma(),
          pages,
          questions,
          budget,
          totals,
        );
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
        failureStreak = 0;
      } catch (err) {
        // A wedged engine or a flaky night must not crash the sweep. Leave
        // the origin unfinished — immediately retryable, an infra blip rather
        // than a verdict — and escalate if it keeps happening.
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  ${group.origin}: failed, left due — ${message}`);
        failureStreak++;
        totals.extractionFailures = (totals.extractionFailures ?? 0) + 1;
        if (failureStreak >= SYSTEMIC_FAILURE_STREAK) {
          console.error(
            `  aborting: ${failureStreak} consecutive origin failures (engine wedged? db down?)`,
          );
          // The summary still prints, but the run must read as failed in CI.
          process.exitCode = 1;
          return false;
        }
      }
      return true;
    };

    try {
      if (claimInstance) {
        const instance = claimInstance;
        const claimOrigins = makeClaimOrigins(db);
        const releaseClaims = makeReleaseClaims(db);
        const renewClaims = makeRenewClaims(db);
        const selectDue = makeSelectDueCompanies(db);

        /** A coordination write must never kill a GPU run: log, count, move
         *  on — a lost release simply ages out via the lease. */
        const tryCoord = async (
          label: string,
          write: () => Promise<unknown>,
        ): Promise<boolean> => {
          try {
            await write();
            return true;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(`  claim ${label} failed, continuing — ${message}`);
            totals.claimErrors = (totals.claimErrors ?? 0) + 1;
            return false;
          }
        };

        let processed = 0;
        let aborted = false;

        /**
         * Walk a candidate list once, claiming and processing until the win
         * target is met. Returns the groups offered but not won, so the
         * caller can retry them once — a peer may complete them (the recheck
         * drops those) or hand claims back from an aborted batch after this
         * worker's cursor has already passed them.
         */
        const drain = async (list: OriginGroup[]): Promise<OriginGroup[]> => {
          const leftover: OriginGroup[] = [];
          let cursor = 0;
          while (!aborted && processed < dueLimit && cursor < list.length) {
            const want = Math.min(CLAIM_BATCH, dueLimit - processed);
            const slice = list.slice(cursor, cursor + want);
            cursor += slice.length;
            let won: string[];
            try {
              won = await claimOrigins(
                instance,
                slice.map((group) => group.origin),
                want,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.log(`  claim round failed, continuing — ${message}`);
              totals.claimErrors = (totals.claimErrors ?? 0) + 1;
              leftover.push(...slice);
              continue;
            }
            const wonSet = new Set(won);
            leftover.push(...slice.filter((g) => !wonSet.has(g.origin)));
            totals.claimsSkipped =
              (totals.claimsSkipped ?? 0) + slice.length - won.length;
            if (won.length === 0) continue;

            // The ledger, not the claim table, decides dueness: this run's
            // list is a startup snapshot, and a peer completing an origin
            // deletes its claim — indistinguishable from never-claimed. So
            // re-run the SAME due predicate over just the won batch and hand
            // back whatever a peer already finished.
            let wonGroups = slice.filter((g) => wonSet.has(g.origin));
            try {
              const stillDue = new Set(
                (
                  await selectDue(
                    hashPairs,
                    MODEL_STAMP,
                    wonGroups.flatMap((g) =>
                      g.companies.map((c) => c.companyNumber),
                    ),
                  )
                ).map((c) => c.companyNumber),
              );
              const done = wonGroups.filter(
                (g) => !g.companies.some((c) => stillDue.has(c.companyNumber)),
              );
              if (done.length > 0) {
                totals.claimsCompletedElsewhere =
                  (totals.claimsCompletedElsewhere ?? 0) + done.length;
                await tryCoord('release', () =>
                  releaseClaims(
                    instance,
                    done.map((g) => g.origin),
                  ),
                );
                wonGroups = wonGroups.filter((g) =>
                  g.companies.some((c) => stillDue.has(c.companyNumber)),
                );
              }
            } catch (err) {
              // The recheck is an optimization; on failure proceed with the
              // full batch — duplicate work is tolerated, lost work is not.
              // But say so: a silently failing recheck is silent double work.
              const message = err instanceof Error ? err.message : String(err);
              console.log(`  claim recheck failed, continuing — ${message}`);
              totals.claimErrors = (totals.claimErrors ?? 0) + 1;
            }
            if (wonGroups.length === 0) continue;
            totals.claimsWon = (totals.claimsWon ?? 0) + wonGroups.length;

            const unfinished = new Set(wonGroups.map((g) => g.origin));
            try {
              for (const group of wonGroups) {
                // Renewal keeps the batch tail inside the lease however slow
                // the preceding origins run. Fewer rows renewed than held
                // means a lease lapsed and a peer may redo that origin —
                // surfaced in totals rather than left as silent double work.
                try {
                  const renewed = await renewClaims(instance, [...unfinished]);
                  if (renewed < unfinished.size) {
                    totals.claimsLost =
                      (totals.claimsLost ?? 0) + (unfinished.size - renewed);
                  }
                } catch (err) {
                  const message =
                    err instanceof Error ? err.message : String(err);
                  console.log(`  claim renew failed, continuing — ${message}`);
                  totals.claimErrors = (totals.claimErrors ?? 0) + 1;
                }
                const ok = await processGroup(group);
                if (
                  await tryCoord('release', () =>
                    releaseClaims(instance, [group.origin]),
                  )
                ) {
                  unfinished.delete(group.origin);
                }
                processed++;
                if (!ok) {
                  aborted = true;
                  break;
                }
              }
            } finally {
              // An aborted batch must not shadow its unprocessed origins for
              // a whole lease; hand them straight back (also retries any
              // per-origin release that failed above).
              if (unfinished.size > 0) {
                await tryCoord('release', () =>
                  releaseClaims(instance, [...unfinished]),
                );
              }
            }
          }
          return leftover;
        };

        const contested = await drain(groups);
        if (!aborted && processed < dueLimit && contested.length > 0) {
          await drain(contested);
        }
      } else {
        for (const group of groups) {
          if (!(await processGroup(group))) break;
        }
      }
    } finally {
      if (gemma) await gemma.stop();
    }
  }
}

const seconds = (Date.now() - startedAt) / 1000;
console.log('Done.');
for (const key of Object.keys(totals).sort()) {
  console.log(`  ${key}: ${totals[key]}`);
}
if (totals.answers) {
  console.log(
    `  insufficient rate: ${((insufficientCount(totals) / totals.answers) * 100).toFixed(1)}%`,
  );
}
if (totals.origins) {
  console.log(`  seconds/origin: ${(seconds / totals.origins).toFixed(1)}`);
}
// On Actions, the same totals land on the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    renderRunSummary(modeLabel, totals, seconds),
  );
}
