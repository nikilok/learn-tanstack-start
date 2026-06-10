import {
  companiesHouseProfiles,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
} from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { asc, desc, eq, sql } from 'drizzle-orm';

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
    // One row per (org, rating, route): the same org can hold several licences
    // with otherwise identical feed data (888 groups in the 2026-06 feed), and
    // the cards show nothing that distinguishes them. min(hash) is the
    // canonical slugId — the detail loader 301s the siblings to it.
    // Grouping happens in the subquery, BEFORE the CH joins, so the joins stay
    // PK probes on the returned window only and ranking/LIMIT are unaffected.
    const grouped = db
      .select({
        slugId: sql<string>`min(${hmrcSkilledWorkers.hash})`.as('slug_id'),
        organisationName: hmrcSkilledWorkers.organisationName,
        nameSlug: hmrcSkilledWorkers.nameSlug,
        sponsorLicenceNumbers: sql<
          string[]
        >`coalesce(array_agg(distinct ${hmrcSkilledWorkers.sponsorLicenceNumber}) filter (where ${hmrcSkilledWorkers.sponsorLicenceNumber} is not null), '{}')`.as(
          'sponsor_licence_numbers',
        ),
        typeRating: hmrcSkilledWorkers.typeRating,
        route: hmrcSkilledWorkers.route,
        score: scoreExpr.as('score'),
      })
      .from(hmrcSkilledWorkers)
      .where(
        sql`(
          ${hmrcSkilledWorkers.organisationName} ~* ${wordBoundaryPattern}
          OR word_similarity(${query}, ${hmrcSkilledWorkers.organisationName}) > 0.6
          OR similarity(${query}, ${hmrcSkilledWorkers.organisationName}) > 0.5
        )`,
      )
      .groupBy(
        hmrcSkilledWorkers.organisationName,
        hmrcSkilledWorkers.nameSlug,
        hmrcSkilledWorkers.typeRating,
        hmrcSkilledWorkers.route,
      )
      .orderBy(
        desc(scoreExpr),
        sql`${hmrcSkilledWorkers.organisationName} ASC`,
        // Unique tiebreak: groups tie on score AND name, and unstable tie
        // order across page fetches duplicates/drops rows at OFFSET boundaries
        sql`min(${hmrcSkilledWorkers.hash}) ASC`,
      )
      .limit(PAGE_SIZE + 1)
      .offset(offset)
      .as('g');

    // Listing location is CH-sourced (HMRC dropped town/county from the feed).
    const rows = await db
      .select({
        slugId: grouped.slugId,
        organisationName: grouped.organisationName,
        nameSlug: grouped.nameSlug,
        sponsorLicenceNumbers: grouped.sponsorLicenceNumbers,
        locality: sql<
          string | null
        >`COALESCE(${companiesHouseProfiles.locality}, ${companiesHouseProfiles.addressLine2})`,
        region: companiesHouseProfiles.region,
        typeRating: grouped.typeRating,
        route: grouped.route,
        score: grouped.score,
      })
      .from(grouped)
      .leftJoin(
        hmrcCompanyMapping,
        eq(hmrcCompanyMapping.organisationName, grouped.organisationName),
      )
      .leftJoin(
        companiesHouseProfiles,
        eq(
          companiesHouseProfiles.companyNumber,
          hmrcCompanyMapping.companyNumber,
        ),
      )
      // Joins don't guarantee order preservation; re-sort the ≤51-row window
      .orderBy(
        desc(grouped.score),
        asc(grouped.organisationName),
        asc(grouped.slugId),
      );

    const hasMore = rows.length > PAGE_SIZE;
    return {
      rows: rows.slice(0, PAGE_SIZE),
      hasMore,
    };
  });

/**
 * Server fn returning a single `hmrc_skilled_workers` row keyed by its stable
 * `hash` slug id. Returns `null` when no matching row exists. Also returns the
 * group canonical: multi-licence orgs have one row per licence with identical
 * (org, rating, route) — search lists only min(hash), and the loader 301s the
 * sibling hashes to `canonicalSlugId`. `sponsorLicenceNumbers` carries every
 * licence in the group so the canonical page shows all of them.
 */
const getHmrcBySlugId = createServerFn()
  .inputValidator((input: unknown) => input as { slugId: string })
  .handler(async ({ data: { slugId } }) => {
    const groupFilter = sql`
      h2.organisation_name = ${hmrcSkilledWorkers.organisationName}
      AND h2.type_rating = ${hmrcSkilledWorkers.typeRating}
      AND h2.route = ${hmrcSkilledWorkers.route}`;
    const [row] = await db
      .select({
        slugId: hmrcSkilledWorkers.hash,
        canonicalSlugId: sql<string>`(
          SELECT min(h2.hash) FROM hmrc_skilled_workers h2 WHERE ${groupFilter}
        )`,
        organisationName: hmrcSkilledWorkers.organisationName,
        sponsorLicenceNumbers: sql<string[]>`(
          SELECT coalesce(array_agg(distinct h2.sponsor_licence_number) filter (where h2.sponsor_licence_number is not null), '{}')
          FROM hmrc_skilled_workers h2 WHERE ${groupFilter}
        )`,
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

/** Server fn returning the count of distinct sponsor organisations. Edge-cached on the /_serverFn/ RPC path (client fetch); only changes on ingestion. */
export const getSponsorCount = createServerFn().handler(async () => {
  const [row] = await db
    .select({
      count: sql<number>`count(distinct ${hmrcSkilledWorkers.organisationName})::int`,
    })
    .from(hmrcSkilledWorkers);
  setRpcCacheControl(LONG_EDGE_CACHE);
  return row?.count ?? 0;
});

/** React Query options for `getSponsorCount`. Rarely changes, so never refetch within a session. */
export const sponsorCountQueryOptions = queryOptions({
  queryKey: ['sponsor-count'],
  queryFn: () => getSponsorCount(),
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * Server fn returning `hmrc_skilled_workers` rows whose `name_slug` matches
 * the given slug. Fallback for stale `/company/$id/$slug` URLs: when the hash
 * lookup 404s, the loader checks whether the name still maps to a current row
 * and 301s to its new hash. Capped at 2 since callers only branch on 0 / 1 / many.
 * Ordered by hash so the multi-match 301 always picks the same canonical row.
 * Not wrapped in queryOptions — only the loader calls it, and the redirect
 * moves the user off this page so there's no second reader for the result.
 */
export const getHmrcBySlug = createServerFn()
  .inputValidator((input: unknown) => input as { slug: string })
  .handler(async ({ data: { slug } }) => {
    if (!/^[a-z0-9-]{1,255}$/.test(slug)) return [];
    const rows = await db
      .select({
        slugId: hmrcSkilledWorkers.hash,
        organisationName: hmrcSkilledWorkers.organisationName,
      })
      .from(hmrcSkilledWorkers)
      .where(eq(hmrcSkilledWorkers.nameSlug, slug))
      .orderBy(asc(hmrcSkilledWorkers.hash))
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

export type HmrcRow = Awaited<ReturnType<typeof searchHmrc>>['rows'][number];
