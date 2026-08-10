/**
 * Selection and write factories for the profiles crawl. Statements stay dumb;
 * the population predicate is publishableWebsiteGate() by reference — never a
 * copied condition — so this surface and the render gate cannot drift.
 */

import type { createClient } from '@ss/db/client';
import { companyPageSnapshots, companyWebsites } from '@ss/db/schema';
import { and, eq, sql } from 'drizzle-orm';

import { publishableWebsiteGate } from '../websites/publishable';
import { type CrawlPage, snapshotOrigin } from './crawl';

type Db = ReturnType<typeof createClient>;

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

/** The publishable crawl base for one company, or null when it has none. */
export function makeResolveCompanyUrl(db: Db) {
  return async (companyNumber: string): Promise<string | null> => {
    const [row] = await db
      .select({ url: companyWebsites.url })
      .from(companyWebsites)
      .where(
        and(
          publishableWebsiteGate(),
          eq(companyWebsites.companyNumber, companyNumber),
        ),
      )
      .limit(1);
    return row?.url ?? null;
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
