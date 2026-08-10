/**
 * Selection and write factories for the profiles crawl. Statements stay dumb;
 * the population predicate is publishableWebsiteGate() by reference — never a
 * copied condition — so this surface and the render gate cannot drift.
 */

import type { createClient } from '@ss/db/client';
import {
  companyAnswers,
  companyPageSnapshots,
  companyWebsites,
  profileQuestions,
} from '@ss/db/schema';
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';

import {
  answersRetentionGate,
  publishableWebsiteGate,
} from '../websites/publishable';
import type { AnswerRow } from './answers';
import { type CrawlPage, snapshotOrigin } from './crawl';
import type { ProfileQuestion, QuestionKind } from './extract';

type Db = ReturnType<typeof createClient>;

/** Active questions in ask-assembly order — the live contract every run
 *  re-reads from the table rather than assuming. */
export function makeSelectActiveQuestions(db: Db) {
  return async (): Promise<ProfileQuestion[]> => {
    const rows = await db
      .select({
        slug: profileQuestions.slug,
        prompt: profileQuestions.prompt,
        kind: profileQuestions.kind,
        intent: profileQuestions.intent,
        sort: profileQuestions.sort,
      })
      .from(profileQuestions)
      .where(eq(profileQuestions.active, true))
      .orderBy(profileQuestions.sort);
    return rows.map((row) => ({ ...row, kind: row.kind as QuestionKind }));
  };
}

export type CrawlTarget = {
  /** The stored website URL, the crawl base. */
  url: string;
  /** Companies this URL is publishable for; shared domains crawl once. */
  companies: number;
};

/**
 * Days a crawled origin is left alone before it is a re-crawl candidate. Once
 * the backfill drains, snapshots must still refresh — but not every night. An
 * origin crawled inside this window is skipped; past it, oldest re-crawls
 * first. Pilot-tunable (the plan sets the true cadence after backfill).
 */
export const RECRAWL_AFTER_DAYS = 30;

/**
 * Publishable crawl bases in rotation order: never-crawled first, then oldest
 * snapshot first, skipping origins crawled within RECRAWL_AFTER_DAYS. Without
 * the recency key the sweep re-crawls the same alphabetical head every night
 * and the tail never refreshes. The whole target set is small (thousands), so
 * ordering happens in TypeScript against snapshotOrigin — the same origin rule
 * the crawler stamps rows with — rather than re-deriving the origin in SQL.
 */
export function makeSelectCrawlTargets(db: Db) {
  return async (limit: number): Promise<CrawlTarget[]> => {
    const rows = await db
      .select({
        url: companyWebsites.url,
        companies: sql<number>`count(*)::int`,
      })
      .from(companyWebsites)
      .where(publishableWebsiteGate())
      .groupBy(companyWebsites.url);
    // Newest fetch per origin: the rotation key and the recency floor.
    const lastCrawled = new Map(
      (
        await db
          .select({
            origin: companyPageSnapshots.origin,
            fetchedAt: sql<string>`max(${companyPageSnapshots.fetchedAt})`,
          })
          .from(companyPageSnapshots)
          .groupBy(companyPageSnapshots.origin)
      ).map((row) => [row.origin, new Date(row.fetchedAt).getTime()]),
    );
    const floor = Date.now() - RECRAWL_AFTER_DAYS * 86_400_000;
    return rows
      .flatMap((row) => {
        if (!row.url) return [];
        const crawledAt = lastCrawled.get(snapshotOrigin(row.url));
        // Skip freshly-crawled origins; never-crawled (undefined) always pass.
        if (crawledAt !== undefined && crawledAt > floor) return [];
        return [{ url: row.url, companies: row.companies, crawledAt }];
      })
      .sort(
        (a, b) =>
          // never-crawled (undefined → -Infinity) first, then oldest first.
          (a.crawledAt ?? -Infinity) - (b.crawledAt ?? -Infinity) ||
          a.url.localeCompare(b.url),
      )
      .slice(0, limit)
      .map(({ url, companies }) => ({ url, companies }));
  };
}

export type CompanyWebsite = { url: string; evidence: string };

/** The publishable crawl base + evidence tier for one company, or null. */
export function makeResolveCompanyWebsite(db: Db) {
  return async (companyNumber: string): Promise<CompanyWebsite | null> => {
    const [row] = await db
      .select({
        url: companyWebsites.url,
        evidence: companyWebsites.evidence,
      })
      .from(companyWebsites)
      .where(
        and(
          publishableWebsiteGate(),
          eq(companyWebsites.companyNumber, companyNumber),
        ),
      )
      .limit(1);
    return row?.url ? { url: row.url, evidence: row.evidence } : null;
  };
}

export type DueCompany = {
  companyNumber: string;
  url: string;
  evidence: string;
};

/**
 * Days before a non-ok answer (`error` or `insufficient_content`) is retried.
 *
 * An `ok` answer is terminal for its (hash, model): re-extraction changes
 * nothing until the prompt or model does. A non-ok answer is NOT terminal —
 * a model schema-failure is transient, and an `insufficient_content` written
 * while a site was temporarily unreadable should be re-tried once the crawl
 * sweep stores good snapshots. Without this window a single flaky night would
 * exclude a company from extraction forever. Pilot-tunable.
 */
export const PROFILE_RETRY_DAYS = 7;

/**
 * Companies due for extraction. Missing, hash-stale, model-stale and
 * stale-non-ok collapse into one predicate: due means some active question has
 * no `ok` row matching its current ask hash and the current model, and no
 * recent non-ok attempt against them either. That makes a prompt edit or a
 * model-pin bump self-invalidating AND keeps a transient failure from becoming
 * a permanent exclusion (see PROFILE_RETRY_DAYS). Ordered never-answered first
 * (min extracted_at NULLS FIRST), no LIMIT: the caller groups by origin,
 * filters, and caps.
 */
export function makeSelectDueCompanies(db: Db) {
  return async (
    hashes: { slug: string; hash: string }[],
    model: string,
  ): Promise<DueCompany[]> => {
    const pairs = sql.join(
      hashes.map((entry) => sql`(${entry.slug}, ${entry.hash})`),
      sql`, `,
    );
    const rows = await db
      .select({
        companyNumber: companyWebsites.companyNumber,
        url: companyWebsites.url,
        evidence: companyWebsites.evidence,
      })
      .from(companyWebsites)
      .where(
        and(
          publishableWebsiteGate(),
          sql`EXISTS (
            SELECT 1 FROM (VALUES ${pairs}) AS q(slug, hash)
            WHERE NOT EXISTS (
              SELECT 1 FROM company_answers a
              WHERE a.company_number = ${companyWebsites.companyNumber}
                AND a.question_slug = q.slug
                AND a.question_hash = q.hash
                AND a.model = ${model}
                AND (
                  a.status = 'ok'
                  OR a.extracted_at > now() - make_interval(days => ${PROFILE_RETRY_DAYS})
                )
            )
          )`,
        ),
      )
      .orderBy(
        sql`(SELECT min(a.extracted_at) FROM company_answers a WHERE a.company_number = "company_websites"."company_number") ASC NULLS FIRST`,
        companyWebsites.companyNumber,
      );
    return rows.flatMap((row) =>
      row.url
        ? [
            {
              companyNumber: row.companyNumber,
              url: row.url,
              evidence: row.evidence,
            },
          ]
        : [],
    );
  };
}

/** Publishable websites for an explicit company list — the pilot's entry
 *  point, so a stratified sample runs through the exact pipeline path. */
export function makeResolveCompanyWebsites(db: Db) {
  return async (companyNumbers: string[]): Promise<DueCompany[]> => {
    if (companyNumbers.length === 0) return [];
    const rows = await db
      .select({
        companyNumber: companyWebsites.companyNumber,
        url: companyWebsites.url,
        evidence: companyWebsites.evidence,
      })
      .from(companyWebsites)
      .where(
        and(
          publishableWebsiteGate(),
          inArray(companyWebsites.companyNumber, companyNumbers),
        ),
      );
    return rows.flatMap((row) =>
      row.url
        ? [
            {
              companyNumber: row.companyNumber,
              url: row.url,
              evidence: row.evidence,
            },
          ]
        : [],
    );
  };
}

/** Origins that have any snapshot rows — what --from-snapshots can serve. */
export function makeSelectSnapshotOrigins(db: Db) {
  return async (): Promise<Set<string>> => {
    const rows = await db
      .selectDistinct({ origin: companyPageSnapshots.origin })
      .from(companyPageSnapshots);
    return new Set(rows.map((row) => row.origin));
  };
}

export type SnapshotPage = {
  path: string;
  url: string;
  contentText: string;
  contentHash: string | null;
};

/**
 * Prune an origin's snapshots down to the pages a crawl just kept, so the
 * corpus stays bounded to the current frontier plus hand-gathered rows. The
 * 8-page-per-crawl cap does not bound the extract sweep on its own: paths that
 * drop out of later frontiers (a site redesign, a changed nav or sitemap)
 * would otherwise persist as `ok` rows forever, growing per-origin Gemma cost
 * and grounding fresh answers in text the site no longer serves. `manual` rows
 * are never pruned (they outrank the crawler). The caller must only reconcile
 * a crawl that READ the site: a blocked or erroring crawl still returns
 * failure-row paths, so a non-empty kept-set alone does not prove the frontier
 * was real — the empty-set no-op here is a last-resort belt, not that guard.
 * Returns the count removed.
 */
export function makeReconcileOrigin(db: Db) {
  return async (origin: string, keptPaths: string[]): Promise<number> => {
    if (keptPaths.length === 0) return 0;
    const deleted = await db
      .delete(companyPageSnapshots)
      .where(
        and(
          eq(companyPageSnapshots.origin, origin),
          ne(companyPageSnapshots.fetchMethod, 'manual'),
          notInArray(companyPageSnapshots.path, keptPaths),
        ),
      )
      .returning({ id: companyPageSnapshots.id });
    return deleted.length;
  };
}

/** An origin's readable corpus — the --from-snapshots page source. Bounded by
 *  makeReconcileOrigin to the current frontier plus manual rows. */
export function makeSelectOkSnapshots(db: Db) {
  return async (origin: string): Promise<SnapshotPage[]> => {
    const rows = await db
      .select({
        path: companyPageSnapshots.path,
        url: companyPageSnapshots.url,
        contentText: companyPageSnapshots.contentText,
        contentHash: companyPageSnapshots.contentHash,
      })
      .from(companyPageSnapshots)
      .where(
        and(
          eq(companyPageSnapshots.origin, origin),
          eq(companyPageSnapshots.status, 'ok'),
        ),
      )
      .orderBy(companyPageSnapshots.path);
    return rows.flatMap((row) =>
      row.contentText ? [{ ...row, contentText: row.contentText }] : [],
    );
  };
}

/**
 * Batch-upsert one origin's answer rows on (company_number, question_slug).
 *
 * A non-ok result never overwrites an existing `ok` answer: a transient
 * unreadable crawl (WAF, timeout, a manual-snapshot origin the fetch tier
 * can't read) would otherwise regress good answers to insufficient_content.
 * The stale-but-real ok row keeps its old (hash, model), so the due predicate
 * still sees the question as unsatisfied and retries — a later good extraction
 * overwrites it. A fresh `ok` always wins, so genuine staleness re-extraction
 * proceeds normally.
 */
export function makeUpsertAnswers(db: Db) {
  return async (rows: AnswerRow[]): Promise<void> => {
    if (rows.length === 0) return;
    await db
      .insert(companyAnswers)
      .values(
        rows.map((row) => ({
          companyNumber: row.companyNumber,
          questionSlug: row.questionSlug,
          questionHash: row.questionHash,
          questionText: row.questionText,
          answer: row.answer,
          items: row.items,
          sourceUrls: row.sourceUrls,
          identityEvidence: row.identityEvidence,
          model: row.model,
          status: row.status,
        })),
      )
      .onConflictDoUpdate({
        target: [companyAnswers.companyNumber, companyAnswers.questionSlug],
        set: {
          questionHash: sql`excluded.question_hash`,
          questionText: sql`excluded.question_text`,
          answer: sql`excluded.answer`,
          items: sql`excluded.items`,
          sourceUrls: sql`excluded.source_urls`,
          identityEvidence: sql`excluded.identity_evidence`,
          model: sql`excluded.model`,
          status: sql`excluded.status`,
          extractedAt: sql`now()`,
        },
        setWhere: sql`excluded.status = 'ok' OR ${companyAnswers.status} <> 'ok'`,
      });
  };
}

/**
 * Answer rows do not survive their website row's demotion — but they are
 * never silently destroyed either: archive, then delete, in ONE statement so
 * a row can never be deleted without an archive copy.
 *
 * A single data-modifying CTE gives that atomicity on the transactionless HTTP
 * driver: all three arms share one snapshot, the DELETE targets exactly the
 * `orphaned` set the INSERT read (not a re-evaluation of the predicate, which
 * a concurrent write could shift between two statements), and the archive
 * INSERT is idempotent (`ON CONFLICT (id) DO NOTHING`) so a crash-and-retry
 * duplicates nothing. Orphaning uses answersRetentionGate — wider than the
 * render gate — so a company's corpus is not churned over a single sweep's
 * transient `unreachable`. Snapshots stay; the origin corpus remains valid
 * fact about the website itself.
 */
export function makeInvalidateOrphanedAnswers(db: Db) {
  return async (): Promise<number> => {
    const result = await db.execute(sql`
      WITH orphaned AS (
        SELECT a.* FROM company_answers a
        WHERE NOT EXISTS (
          SELECT 1 FROM company_websites
          WHERE ${answersRetentionGate()}
            AND "company_websites"."company_number" = a.company_number
        )
      ),
      archived AS (
        INSERT INTO company_answers_archive
          (id, company_number, question_slug, question_hash, question_text,
           answer, items, source_urls, identity_evidence, model, status,
           extracted_at, reason)
        SELECT id, company_number, question_slug, question_hash, question_text,
               answer, items, source_urls, identity_evidence, model, status,
               extracted_at, 'website_demoted'
        FROM orphaned
        ON CONFLICT (id) DO NOTHING
      )
      DELETE FROM company_answers
      WHERE id IN (SELECT id FROM orphaned)
      RETURNING id
    `);
    return result.rows.length;
  };
}

/**
 * Upsert one crawled page as its origin's snapshot for that path.
 *
 * The update is guarded two ways. A hand-gathered `manual` row outranks the
 * crawler and is never touched. And a NON-ok result never overwrites an
 * existing `ok` row — the corpus is the asset extraction re-reads on every
 * prompt/model change, and a re-crawl that transiently WAF-challenges or times
 * out on a page we already read must not null its stored text (the site may
 * now block refetch, destroying the corpus permanently). A fresh `ok` result
 * always wins (new content); a failure only writes where there was no good
 * content to lose. An origin we can already read is not an escalation
 * candidate anyway, so dropping the failure signal there costs nothing.
 */
export function makeUpsertSnapshot(db: Db) {
  return async (origin: string, page: CrawlPage): Promise<void> => {
    await db
      .insert(companyPageSnapshots)
      .values({
        origin,
        path: page.path,
        url: page.url,
        status: page.status,
        failure: page.failure,
        contentText: page.contentText,
        contentHash: page.contentHash,
        bytes: page.bytes,
        fetchMethod: 'fetch',
      })
      .onConflictDoUpdate({
        target: [companyPageSnapshots.origin, companyPageSnapshots.path],
        set: {
          url: page.url,
          status: page.status,
          failure: page.failure,
          contentText: page.contentText,
          contentHash: page.contentHash,
          bytes: page.bytes,
          fetchMethod: 'fetch',
          fetchedAt: sql`now()`,
        },
        setWhere: sql`${companyPageSnapshots.fetchMethod} <> 'manual'
          AND (excluded.status = 'ok' OR ${companyPageSnapshots.status} <> 'ok')`,
      });
  };
}
