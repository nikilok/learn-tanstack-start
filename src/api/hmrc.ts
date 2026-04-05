import { createServerFn } from '@tanstack/react-start';
import { desc, sql } from 'drizzle-orm';
import { db } from '../db';
import { hmrcSkilledWorkers } from '../db/schema';

const PAGE_SIZE = 50;

export const searchHmrc = createServerFn()
  .inputValidator(
    (input: unknown) => input as { query: string; offset: number },
  )
  .handler(async ({ data: { query, offset } }) => {
    if (query.length < 3) return { rows: [], hasMore: false };
    console.log(`[HMRC Search] query="${query}" offset=${offset}`);
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const rows = await db
      .select({
        id: hmrcSkilledWorkers.id,
        organisationName: hmrcSkilledWorkers.organisationName,
        townCity: hmrcSkilledWorkers.townCity,
        county: hmrcSkilledWorkers.county,
        typeRating: hmrcSkilledWorkers.typeRating,
        route: hmrcSkilledWorkers.route,
        score: sql<number>`
          CASE WHEN ${hmrcSkilledWorkers.organisationName} ILIKE ${`%${escaped}%`}
            THEN 1.0 + word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
            ELSE word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
          END`,
      })
      .from(hmrcSkilledWorkers)
      .where(
        sql`(
          ${hmrcSkilledWorkers.organisationName} ILIKE ${`%${escaped}%`}
          OR word_similarity(${query}, ${hmrcSkilledWorkers.organisationName}) > 0.6
        )`,
      )
      .orderBy(
        desc(sql`
          CASE WHEN ${hmrcSkilledWorkers.organisationName} ILIKE ${`%${escaped}%`}
            THEN 1.0 + word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
            ELSE word_similarity(${query}, ${hmrcSkilledWorkers.organisationName})
          END`),
      )
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    const hasMore = rows.length > PAGE_SIZE;
    return { rows: rows.slice(0, PAGE_SIZE), hasMore };
  });

export { PAGE_SIZE };

export type HmrcRow = Awaited<ReturnType<typeof searchHmrc>>['rows'][number];
