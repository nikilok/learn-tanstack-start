import { hmrcSkilledWorkers } from '@ss/db';
import { createServerFn } from '@tanstack/react-start';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db.server';

const PAGE_SIZE = 50;

export const searchHmrc = createServerFn()
  .inputValidator(
    (input: unknown) => input as { query: string; offset: number },
  )
  .handler(async ({ data: { query, offset } }) => {
    if (query.length < 3) return { rows: [], hasMore: false };
    console.log(`[HMRC Search] query="${query}" offset=${offset}`);
    const regexEscaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordBoundaryPattern = `\\m${regexEscaped}`;
    const scoreExpr = sql<number>`
      CASE
        WHEN ${hmrcSkilledWorkers.organisationName} ~* ${`^${regexEscaped}`}
          THEN 2.0 + word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
        WHEN ${hmrcSkilledWorkers.organisationName} ~* ${wordBoundaryPattern}
          THEN 1.0 + word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
        ELSE word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
      END`;
    const rows = await db
      .select({
        slugId: hmrcSkilledWorkers.hash,
        organisationName: hmrcSkilledWorkers.organisationName,
        townCity: hmrcSkilledWorkers.townCity,
        county: hmrcSkilledWorkers.county,
        typeRating: hmrcSkilledWorkers.typeRating,
        route: hmrcSkilledWorkers.route,
        score: scoreExpr,
      })
      .from(hmrcSkilledWorkers)
      .where(
        sql`(
          ${hmrcSkilledWorkers.organisationName} ~* ${wordBoundaryPattern}
          OR word_similarity(${query}, ${hmrcSkilledWorkers.organisationName}) > 0.6
          OR similarity(${query}, ${hmrcSkilledWorkers.organisationName}) > 0.5
        )`,
      )
      .orderBy(desc(scoreExpr), sql`${hmrcSkilledWorkers.organisationName} ASC`)
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    const hasMore = rows.length > PAGE_SIZE;
    return {
      rows: rows.slice(0, PAGE_SIZE),
      hasMore,
    };
  });

export const getHmrcBySlugId = createServerFn()
  .inputValidator((input: unknown) => input as { slugId: string })
  .handler(async ({ data: { slugId } }) => {
    const [row] = await db
      .select({
        slugId: hmrcSkilledWorkers.hash,
        organisationName: hmrcSkilledWorkers.organisationName,
        townCity: hmrcSkilledWorkers.townCity,
        county: hmrcSkilledWorkers.county,
        typeRating: hmrcSkilledWorkers.typeRating,
        route: hmrcSkilledWorkers.route,
      })
      .from(hmrcSkilledWorkers)
      .where(eq(hmrcSkilledWorkers.hash, slugId))
      .limit(1);

    return row ?? null;
  });

export { PAGE_SIZE };

export type HmrcRow = Awaited<ReturnType<typeof searchHmrc>>['rows'][number];
