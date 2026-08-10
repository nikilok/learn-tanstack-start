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
import { and, eq, inArray, sql } from 'drizzle-orm';

import { publishableWebsiteGate } from '../websites/publishable';
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
 * Publishable crawl bases, never-crawled origins first. The whole target set
 * is small (thousands), so ordering happens in TypeScript against
 * snapshotOrigin — the same origin rule the crawler stamps rows with — rather
 * than re-deriving the origin in SQL.
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
    const crawled = new Set(
      (
        await db
          .selectDistinct({ origin: companyPageSnapshots.origin })
          .from(companyPageSnapshots)
      ).map((row) => row.origin),
    );
    return rows
      .flatMap((row) => (row.url ? [{ url: row.url, companies: row.companies }] : []))
      .sort(
        (a, b) =>
          Number(crawled.has(snapshotOrigin(a.url))) -
            Number(crawled.has(snapshotOrigin(b.url))) ||
          a.url.localeCompare(b.url),
      )
      .slice(0, limit);
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
 * Companies due for extraction. Missing, hash-stale and model-stale collapse
 * into one predicate: due means some active question has no row that matches
 * both its current ask hash and the current model — which is exactly what
 * makes a prompt edit or a model-pin bump self-invalidating. Ordered
 * never-answered first (min extracted_at NULLS FIRST), no LIMIT: the caller
 * groups by origin, filters, and caps.
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

/** An origin's readable corpus — the --from-snapshots page source. */
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

/** Batch-upsert one origin's answer rows on (company_number, question_slug). */
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
      });
  };
}

/**
 * Answer rows do not survive their website row's demotion — but they are
 * never silently destroyed either: archive first, then delete, the same
 * trails-first ordering ch-stream uses. A crash between the statements
 * duplicates nothing (the archive carries the original row id as its PK,
 * ON CONFLICT DO NOTHING) and loses nothing. Snapshots stay — the origin
 * corpus remains valid fact about the website itself.
 */
export function makeInvalidateOrphanedAnswers(db: Db) {
  return async (): Promise<number> => {
    // One declaration of "orphaned", shared by both statements; renders
    // against the unaliased tables (publishable.ts requires it).
    const orphaned = sql`NOT EXISTS (
      SELECT 1 FROM company_websites
      WHERE ${publishableWebsiteGate()}
        AND "company_websites"."company_number" = ${companyAnswers.companyNumber}
    )`;
    await db.execute(sql`
      INSERT INTO company_answers_archive
        (id, company_number, question_slug, question_hash, question_text,
         answer, items, source_urls, identity_evidence, model, status,
         extracted_at, reason)
      SELECT id, company_number, question_slug, question_hash, question_text,
             answer, items, source_urls, identity_evidence, model, status,
             extracted_at, 'website_demoted'
      FROM company_answers
      WHERE ${orphaned}
      ON CONFLICT (id) DO NOTHING
    `);
    const deleted = await db
      .delete(companyAnswers)
      .where(orphaned)
      .returning({ id: companyAnswers.id });
    return deleted.length;
  };
}

/** Upsert one crawled page as its origin's snapshot for that path. A
 *  hand-gathered row outranks the crawler, so the update skips 'manual' rows
 *  — without this, one nightly pass replaces a person's work with an error. */
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
        setWhere: sql`${companyPageSnapshots.fetchMethod} <> 'manual'`,
      });
  };
}
