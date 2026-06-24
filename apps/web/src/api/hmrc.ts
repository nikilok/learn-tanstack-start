import {
  chPreviousNames,
  companiesHouseProfiles,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
} from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { asc, eq, type SQL, sql } from 'drizzle-orm';

import { db } from '../db.server';
import { assertNotBot } from './botid';
import {
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setRpcCacheControl,
} from './cache-headers';

const PAGE_SIZE = 50;

type SearchHit = {
  slugId: string;
  organisationName: string;
  nameSlug: string;
  locality: string | null;
  region: string | null;
  typeRating: string;
  route: string;
  score: number;
  matchedPreviousName: string | null;
};

/**
 * Server fn performing a paginated fuzzy search over `hmrc_skilled_workers`
 * and, via the `ch_previous_names` projection, over previous Companies House
 * names of mapped orgs. Ranks prefix matches > word-boundary matches >
 * trigram similarity; an org found under an old name carries that name in
 * `matchedPreviousName` when it outscores the current-name match. Prev-name
 * wins sort below equal-score direct matches (`prev_won`) so renamed orgs
 * can't displace literal matches on common prefix queries. The current-name
 * score only counts when the org actually passed the direct WHERE (`direct`
 * flag → `org_score`); prev-name-only rows therefore always rank by their
 * prev-name score and always carry `matchedPreviousName`. Returns an
 * empty page when the query is under 3 chars. `hasMore` is derived by
 * over-fetching one row past `PAGE_SIZE`.
 *
 * Match predicates pair an index-served trigram OPERATOR with a function
 * recheck (`<%` + word_similarity, `%` + similarity): the operators let the
 * GIN trigram indexes BitmapOr the candidate set (~20x faster than the bare
 * function calls, which can never use an index), while the rechecks pin the
 * exact thresholds against downward GUC drift. NOT immune upward: a pg_trgm
 * GUC raised above 0.6/0.5 becomes the binding filter and silently shrinks
 * results. Keep both halves.
 */
export const searchHmrc = createServerFn()
  .inputValidator(
    (input: unknown) => input as { query: string; offset: number },
  )
  .handler(async ({ data: { query, offset } }) => {
    if (query.length < 3) return { rows: [], hasMore: false };
    await assertNotBot();
    console.log(`[HMRC Search] query="${query}" offset=${offset}`);
    const regexEscaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordBoundaryPattern = `\\m${regexEscaped}`;
    const prefixPattern = `^${regexEscaped}`;
    /** Index-served fuzzy match (operator + threshold recheck) for a name column. */
    const fuzzyMatch = (col: SQL) => sql`(
      ${col} ~* ${wordBoundaryPattern}
      OR (${query} <% ${col} AND word_similarity(${query}, ${col}) > 0.6)
      OR (${col} % ${query} AND similarity(${query}, ${col}) > 0.5)
    )`;
    /** Ranking CASE for a name column: prefix > word-boundary > similarity. */
    const scoreCase = (col: SQL) => sql`CASE
      WHEN ${col} ~* ${prefixPattern} THEN 2.0 + word_similarity(${query}, ${col})
      WHEN ${col} ~* ${wordBoundaryPattern} THEN 1.0 + word_similarity(${query}, ${col})
      ELSE word_similarity(${query}, ${col})
    END`;
    const prevName = sql`pn.name`;
    const orgName = sql`h.organisation_name`;

    // Raw SQL throughout: the shape (CTEs + UNION) exists so every branch
    // stays on an index — pm probes idx_ch_prev_names_trgm then
    // idx_mapping_company_number; the direct branch BitmapOrs
    // idx_hmrc_org_name_trgm; the pm-driven branch probes idx_hmrc_org_name.
    // Folding pm into the direct WHERE as an OR would force a seq scan.
    // The g0 GROUP BY is load-bearing: an org matching both directly AND via
    // a previous name yields two `hits` rows (UNION can't collapse the direct
    // flag) that merge here, bool_or(direct) gating org_score. Only min(hash)
    // is vestigial — 1:1 with hash = org|rating|route, kept for resilience if
    // the hash inputs ever change again; the detail loader 301s any siblings.
    // Grouping/LIMIT happen in `g`, BEFORE the CH location joins, so those
    // stay PK probes on the returned window only.
    // Listing location stays CH-sourced by decision, even though the
    // 2026-06-11 feed revert brought HMRC town/county back.
    const result = await db.execute(sql`
      WITH pm AS (
        SELECT m.organisation_name,
               (array_agg(pn.name ORDER BY ${scoreCase(prevName)} DESC, pn.name ASC))[1] AS matched_name,
               max(${scoreCase(prevName)}) AS prev_score
        FROM ${chPreviousNames} pn
        JOIN ${hmrcCompanyMapping} m ON m.company_number = pn.company_number
        WHERE ${fuzzyMatch(prevName)}
        GROUP BY m.organisation_name
      ),
      hits AS (
        SELECT h.organisation_name, h.name_slug, h.type_rating, h.route, h.hash, true AS direct
        FROM ${hmrcSkilledWorkers} h
        WHERE ${fuzzyMatch(orgName)}
        UNION
        SELECT h.organisation_name, h.name_slug, h.type_rating, h.route, h.hash, false AS direct
        FROM ${hmrcSkilledWorkers} h
        JOIN pm ON pm.organisation_name = h.organisation_name
      ),
      g0 AS (
        SELECT min(h.hash) AS slug_id,
               h.organisation_name,
               h.name_slug,
               h.type_rating,
               h.route,
               -- Gate the current-name score on a real direct match (the flag is
               -- free at WHERE time): for prev-name-only rows scoreCase is
               -- sub-threshold word_similarity noise that would suppress the
               -- "Previously" line and leak past the prev_won demotion
               CASE WHEN bool_or(h.direct) THEN ${scoreCase(orgName)} ELSE 0 END AS org_score,
               pm.matched_name,
               pm.prev_score
        FROM hits h
        LEFT JOIN pm ON pm.organisation_name = h.organisation_name
        GROUP BY h.organisation_name, h.name_slug, h.type_rating, h.route, pm.matched_name, pm.prev_score
      ),
      g AS (
        SELECT slug_id, organisation_name, name_slug, type_rating, route,
               GREATEST(org_score, coalesce(prev_score, 0)) AS score,
               coalesce(prev_score, 0) > org_score AS prev_won,
               CASE WHEN coalesce(prev_score, 0) > org_score
                 THEN matched_name END AS matched_previous_name
        FROM g0
        ORDER BY score DESC, prev_won ASC, organisation_name ASC, slug_id ASC
        -- prev_won demotes prev-name-only wins below same-score direct hits:
        -- they tie prefix queries at full score but would tie-break by their
        -- unrelated current name, flooding page 1 (e.g. 'london').
        -- slug_id (min hash) tiebreak: groups tie on score AND name, and unstable
        -- tie order across page fetches duplicates/drops rows at OFFSET boundaries
        LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}
      )
      SELECT g.slug_id AS "slugId",
             g.organisation_name AS "organisationName",
             g.name_slug AS "nameSlug",
             COALESCE(c.locality, c.address_line_2) AS "locality",
             c.region AS "region",
             g.type_rating AS "typeRating",
             g.route AS "route",
             g.score AS "score",
             g.matched_previous_name AS "matchedPreviousName"
      FROM g
      LEFT JOIN ${hmrcCompanyMapping} m ON m.organisation_name = g.organisation_name
      LEFT JOIN ${companiesHouseProfiles} c ON c.company_number = m.company_number
      -- Joins don't guarantee order preservation; re-sort the ≤51-row window
      -- (must mirror g's ORDER BY exactly or OFFSET pages duplicate/drop rows)
      ORDER BY g.score DESC, g.prev_won ASC, g.organisation_name ASC, g.slug_id ASC
    `);
    const rows = result.rows as SearchHit[];

    const hasMore = rows.length > PAGE_SIZE;
    return {
      rows: rows.slice(0, PAGE_SIZE),
      hasMore,
    };
  });

/**
 * Server fn returning a single `hmrc_skilled_workers` row keyed by its stable
 * `hash` slug id. Returns `null` when no matching row exists. Also returns the
 * group canonical: with hash = org|rating|route the (org, rating, route) group
 * is 1:1 and `canonicalSlugId` equals `slugId` — kept for resilience if the
 * hash inputs ever change again; the loader 301s any siblings to it. Joins the
 * 2026-06-09 `hmrc_sponsor_licences` snapshot on the same triple for the org's
 * sponsor licence number, surfaced only when that match is unambiguous.
 */
const getHmrcBySlugId = createServerFn()
  .inputValidator((input: unknown) => input as { slugId: string })
  .handler(async ({ data: { slugId } }) => {
    await assertNotBot();
    const groupFilter = sql`
      h2.organisation_name = ${hmrcSkilledWorkers.organisationName}
      AND h2.type_rating = ${hmrcSkilledWorkers.typeRating}
      AND h2.route = ${hmrcSkilledWorkers.route}`;
    // Own fragment, not inlined: inside a projection subquery drizzle renders these refs bare, colliding with l.* (→ always null).
    const licFilter = sql`
      l.organisation_name = ${hmrcSkilledWorkers.organisationName}
      AND l.type_rating = ${hmrcSkilledWorkers.typeRating}
      AND l.route = ${hmrcSkilledWorkers.route}`;
    const [row] = await db
      .select({
        slugId: hmrcSkilledWorkers.hash,
        canonicalSlugId: sql<string>`(
          SELECT min(h2.hash) FROM hmrc_skilled_workers h2 WHERE ${groupFilter}
        )`,
        organisationName: hmrcSkilledWorkers.organisationName,
        // The loader 301s slug mismatches onto this (renames leave stale-slug
        // URLs serving 200 with a self-referential canonical otherwise)
        nameSlug: hmrcSkilledWorkers.nameSlug,
        typeRating: hmrcSkilledWorkers.typeRating,
        route: hmrcSkilledWorkers.route,
        // Snapshot licence #, index-probed by org; null unless (org,rating,route) maps to exactly one (~0.6% hold two).
        sponsorLicenceNumber: sql<string | null>`(
          SELECT CASE WHEN count(DISTINCT l.sponsor_licence_number) = 1
                      THEN min(l.sponsor_licence_number) END
          FROM hmrc_sponsor_licences l WHERE ${licFilter}
        )`,
      })
      .from(hmrcSkilledWorkers)
      .where(eq(hmrcSkilledWorkers.hash, slugId))
      .limit(1);

    // Found rows cache long: the hash is content-based (org|rating|route), so
    // data behind it only changes via ingest, and the post-ingest sitemap
    // deploy purges the edge. Nulls cache short — a sponsor can be reinstated
    // under the same hash, and a 30-day-cached null would 301-loop the
    // revived URL against itself.
    setRpcCacheControl(row ? LONG_EDGE_CACHE : SHORT_EDGE_CACHE);

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
 * lookup 404s, the loader 301s to the slug's first row — and also scans the
 * matches for the requested hash itself, which detects a stale cached null
 * (sponsor reinstated under the same hash). Uncapped: rows are per
 * (org, rating, route) and namesake slugs pool orgs, so any cap could hide
 * the requested hash from the containment scan; rows per slug are naturally
 * tiny (max 8 across 126k slugs).
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
      .orderBy(asc(hmrcSkilledWorkers.hash));
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
