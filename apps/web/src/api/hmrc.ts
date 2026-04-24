import { hmrcSkilledWorkers } from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db.server';
import { LONG_EDGE_CACHE, setRpcCacheControl } from './cache-headers';

const PAGE_SIZE = 50;

/**
 * Server fn performing a paginated fuzzy search over `hmrc_skilled_workers`.
 * Combines regex word-boundary matching with pg_trgm similarity, ranking
 * prefix matches > word-boundary matches > trigram similarity. Returns an
 * empty page when the query is under 3 chars. `hasMore` is derived by
 * over-fetching one row past `PAGE_SIZE`.
 */
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
        nameSlug: hmrcSkilledWorkers.nameSlug,
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

/**
 * Server fn returning a single `hmrc_skilled_workers` row keyed by its stable
 * `hash` slug id. Returns `null` when no matching row exists.
 */
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

    // slugId is a content hash of the row — (slugId → data) is immutable, so
    // cache aggressively without tag-based invalidation
    setRpcCacheControl(LONG_EDGE_CACHE);

    return row ?? null;
  });

/**
 * React Query options for `getHmrcBySlugId`. `staleTime: Infinity` since the
 * slug id is a content hash — same id always maps to the same row data, so
 * once cached on the client it never needs to be refetched for this session.
 */
export const hmrcBySlugIdQueryOptions = (slugId: string) =>
  queryOptions({
    queryKey: ['hmrc-by-slug-id', slugId],
    queryFn: () => getHmrcBySlugId({ data: { slugId } }),
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * Server fn returning `hmrc_skilled_workers` rows whose `name_slug` matches
 * the given slug. Fallback for stale `/company/$id/$slug` URLs: when the hash
 * lookup 404s, the loader checks whether the name still maps to a current row
 * and 301s to its new hash. Capped at 2 since callers only branch on 0 / 1 / many.
 * Not wrapped in queryOptions — only the loader calls it, and the redirect
 * moves the user off this page so there's no second reader for the result.
 */
export const getHmrcBySlug = createServerFn()
  .inputValidator((input: unknown) => input as { slug: string })
  .handler(async ({ data: { slug } }) => {
    if (!/^[a-z0-9-]{1,100}$/.test(slug)) return [];
    const rows = await db
      .select({
        slugId: hmrcSkilledWorkers.hash,
        organisationName: hmrcSkilledWorkers.organisationName,
      })
      .from(hmrcSkilledWorkers)
      .where(eq(hmrcSkilledWorkers.nameSlug, slug))
      .limit(2);
    return rows;
  });

/**
 * React Query options for a single-page `searchHmrc` call. Separate cache
 * key from the UI's infinite query (`hmrc-search`) so non-paginated callers
 * (e.g. the MCP tool bridge) can share cache entries across repeated calls
 * without clobbering the infinite-query shape.
 */
export const searchHmrcQueryOptions = (query: string, offset: number) =>
  queryOptions({
    queryKey: ['hmrc-search-page', query, offset],
    queryFn: () => searchHmrc({ data: { query, offset } }),
  });

export { PAGE_SIZE };

export type HmrcRow = Awaited<ReturnType<typeof searchHmrc>>['rows'][number];
