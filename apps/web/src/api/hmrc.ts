import {
  chPreviousNames,
  companiesHouseProfiles,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
} from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db.server';
import { buildNameMatchers } from '../lib/search/name-match';
import { slugify } from '../utils';
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
  typeRatings: string[];
  routes: string[];
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
 * Match predicates come from buildNameMatchers (lib/search/name-match):
 * index-served trigram operators paired with threshold rechecks — see its
 * doc before touching either half.
 */
export const searchHmrc = createServerFn()
  .inputValidator(
    (input: unknown) => input as { query: string; offset: number },
  )
  .handler(async ({ data: { query, offset } }) => {
    if (query.length < 3) return { rows: [], hasMore: false };
    console.log(`[HMRC Search] query="${query}" offset=${offset}`);
    const { fuzzyMatch, scoreCase } = buildNameMatchers(query);
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
               -- Licence rows merge per company: one result per (org, slug),
               -- routes/ratings aggregated. array_to_json so the driver always
               -- hands back JS arrays regardless of its text[] type parsers.
               array_to_json(array_agg(DISTINCT h.route ORDER BY h.route)) AS routes,
               array_to_json(array_agg(DISTINCT h.type_rating ORDER BY h.type_rating)) AS type_ratings,
               -- Gate the current-name score on a real direct match (the flag is
               -- free at WHERE time): for prev-name-only rows scoreCase is
               -- sub-threshold word_similarity noise that would suppress the
               -- "Previously" line and leak past the prev_won demotion
               CASE WHEN bool_or(h.direct) THEN ${scoreCase(orgName)} ELSE 0 END AS org_score,
               pm.matched_name,
               pm.prev_score
        FROM hits h
        LEFT JOIN pm ON pm.organisation_name = h.organisation_name
        GROUP BY h.organisation_name, h.name_slug, pm.matched_name, pm.prev_score
      ),
      g AS (
        SELECT slug_id, organisation_name, name_slug, routes, type_ratings,
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
             g.type_ratings AS "typeRatings",
             g.routes AS "routes",
             -- Transitional scalars for pre-deploy bundles (server fns outlive
             -- the client across a deploy) — drop after the next release cycle.
             g.type_ratings->>0 AS "typeRating",
             g.routes->>0 AS "route",
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

// One licence row of a company page: a (rating, route) pair plus the
// snapshot licence number when the triple maps to exactly one.
export type CompanyLicence = {
  slugId: string;
  organisationName: string;
  typeRating: string;
  route: string;
  sponsorLicenceNumber: string | null;
};

export type CompanyBySlug =
  | {
      kind: 'found';
      organisationName: string;
      orgNames: string[];
      nameSlug: string;
      licences: CompanyLicence[];
    }
  | { kind: 'moved'; nameSlug: string };

// SQL analogue of utils.ts slugify. Identical for ASCII; Unicode full case
// mapping can diverge (JS 'İ' → 'i' + combining dot → extra dash, PG → 'i'),
// so a rare legacy slug misses the fallback and 404s instead of 301ing.
// Expression-indexed (0038) on all three fallback tables — keep the index
// expressions in lockstep with this fragment or the planner reverts to scans.
const slugifySql = (expr: ReturnType<typeof sql>) =>
  sql`btrim(regexp_replace(lower(${expr}), '[^a-z0-9]+', '-', 'g'), '-')`;

/**
 * Server fn returning the full company page group for a `name_slug`: every
 * licence row sharing the slug (multi-route companies merge into one page),
 * ordered so the primary org (mapped to a CH company first, then
 * alphabetically) leads. When the slug matches nothing current, falls back to
 * rename resolution — the slugified form of stale mapping org names and CH
 * previous names — and returns `moved` with the current slug for a 301.
 * Returns `null` for a genuinely unknown slug.
 */
export const getHmrcCompanyBySlug = createServerFn()
  .inputValidator((input: unknown) => input as { slug: string })
  .handler(async ({ data }): Promise<CompanyBySlug | null> => {
    // Normalise URL-ish input (case variants, encoded spaces) to slug form;
    // the loader 301s when the request differs from the canonical slug.
    const slug = slugify(data.slug ?? '');
    if (!/^[a-z0-9-]{1,255}$/.test(slug)) return null;
    const found = await db.execute(sql`
      SELECT h.hash AS "slugId",
             h.organisation_name AS "organisationName",
             h.type_rating AS "typeRating",
             h.route AS "route",
             m.company_number AS "companyNumber",
             (SELECT CASE WHEN count(DISTINCT l.sponsor_licence_number) = 1
                          THEN min(l.sponsor_licence_number) END
              FROM hmrc_sponsor_licences l
              WHERE l.organisation_name = h.organisation_name
                AND l.type_rating = h.type_rating
                AND l.route = h.route) AS "sponsorLicenceNumber"
      FROM ${hmrcSkilledWorkers} h
      LEFT JOIN ${hmrcCompanyMapping} m ON m.organisation_name = h.organisation_name
      WHERE h.name_slug = ${slug}
      ORDER BY (m.company_number IS NULL) ASC, h.organisation_name ASC, h.hash ASC
    `);
    const rows = found.rows as unknown as (CompanyLicence & {
      companyNumber: string | null;
    })[];
    if (rows.length > 0) {
      // Long edge cache: slug pages only change via ingest, and the
      // post-ingest sitemap deploy purges the edge.
      setRpcCacheControl(LONG_EDGE_CACHE);
      // Namesake guard: pool only the primary company's rows — same
      // company_number, or unmapped rows (name-keyed, indistinguishable). A
      // DIFFERENT mapped company sharing the slug is a distinct legal entity
      // and must not leak its licences/name into this page.
      const primaryCompany = rows[0].companyNumber;
      const licences = rows
        .filter(
          (r) => r.companyNumber === primaryCompany || r.companyNumber === null,
        )
        .map(({ companyNumber: _companyNumber, ...licence }) => licence);
      const orgNames = [...new Set(licences.map((l) => l.organisationName))];
      return {
        kind: 'found',
        organisationName: licences[0].organisationName,
        orgNames,
        nameSlug: slug,
        licences,
      };
    }

    // Rename/alias fallback: an unknown slug resolves through the company
    // number — a stale mapping row (HMRC feed renames leave the old org name
    // mapped), a CH previous name, or the CURRENT CH name (the page displays
    // it, so hand-built links use its form: "…-limited" vs HMRC's "…-ltd") —
    // to any current org on the same company. Misses and hits both cache
    // short: unknown slugs can be revived by later ingests.
    // MATERIALIZED fences candidate resolution (index probes on the 0038
    // slugified expression indexes) from the h2 join, and min() replaces
    // ORDER BY+LIMIT so an empty candidate set never walks the slug index —
    // miss and hit paths both run in well under a millisecond.
    const moved = await db.execute(sql`
      WITH cand AS MATERIALIZED (
        SELECT cur.organisation_name
        FROM ${hmrcCompanyMapping} stale
        JOIN ${hmrcCompanyMapping} cur ON cur.company_number = stale.company_number
        WHERE ${slugifySql(sql`stale.organisation_name`)} = ${slug}
        UNION
        SELECT cur.organisation_name
        FROM ${chPreviousNames} pn
        JOIN ${hmrcCompanyMapping} cur ON cur.company_number = pn.company_number
        WHERE ${slugifySql(sql`pn.name`)} = ${slug}
        UNION
        SELECT cur.organisation_name
        FROM ${companiesHouseProfiles} c
        JOIN ${hmrcCompanyMapping} cur ON cur.company_number = c.company_number
        WHERE ${slugifySql(sql`c.company_name`)} = ${slug}
      )
      SELECT min(h2.name_slug) AS "nameSlug"
      FROM cand
      JOIN ${hmrcSkilledWorkers} h2 ON h2.organisation_name = cand.organisation_name
    `);
    setRpcCacheControl(SHORT_EDGE_CACHE);
    const target = (moved.rows as { nameSlug: string | null }[])[0];
    return target?.nameSlug
      ? { kind: 'moved', nameSlug: target.nameSlug }
      : null;
  });

/**
 * React Query options for `getHmrcCompanyBySlug`. Found pages pin for the
 * session (licence data only changes via ingest); moved/null results stay
 * stale so a rename revert or reinstated sponsor is re-resolved on the next
 * navigation instead of a cached miss 404ing/redirecting all session.
 */
export const hmrcCompanyBySlugQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ['hmrc-company-by-slug', slug],
    queryFn: () => getHmrcCompanyBySlug({ data: { slug } }),
    staleTime: (query) =>
      query.state.data?.kind === 'found' ? Number.POSITIVE_INFINITY : 0,
  });

/**
 * Server fn resolving a legacy hash id to its row's current `name_slug`, for
 * the /company/$id/$slug 301 shim. Null when the hash left the register.
 */
export const getSlugForHash = createServerFn()
  .inputValidator((input: unknown) => input as { hash: string })
  .handler(async ({ data: { hash } }) => {
    const [row] = await db
      .select({ nameSlug: hmrcSkilledWorkers.nameSlug })
      .from(hmrcSkilledWorkers)
      .where(eq(hmrcSkilledWorkers.hash, hash))
      .limit(1);
    // Nulls cache short: a sponsor can be reinstated under the same hash.
    setRpcCacheControl(row ? LONG_EDGE_CACHE : SHORT_EDGE_CACHE);
    return row ?? null;
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
