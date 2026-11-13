import { companiesHouseProfiles, hmrcCompanyMapping, sicCodes } from '@ss/db';
import {
  listingOrder,
  orderAsked,
  parseSearchFilters,
} from '@ss/search-filters';
import { createServerFn } from '@tanstack/react-start';
import { sql } from 'drizzle-orm';

import { db } from '../db.server';
import { mayAsk } from '../lib/ask/access.server';
import { rankedIds } from '../lib/ask/ranked-ids';
import { buildNameTermSql } from '../lib/search/prev-name';
import { rankedRestriction } from '../lib/search/ranked';
import { buildFilterConditions } from '../lib/search/sql';
import { SHORT_EDGE_CACHE, setRpcCacheControl } from './cache-headers';

const PAGE_SIZE = 50;
// Hostile deep offsets force full scans; 200 pages is far past any real use.
const MAX_OFFSET = 10_000;

export type FilterSearchRow = {
  slugId: string;
  organisationName: string;
  nameSlug: string;
  locality: string | null;
  region: string | null;
  typeRatings: string[];
  routes: string[];
  licences: { route: string; rating: string }[];
  score: number;
  matchedPreviousName: string | null;
  companyStatus: string | null;
  incorporatedOn: string | null;
  sicPrimary: string | null;
};

/**
 * Server fn behind the native filter capability: filter-capable sponsor
 * listing with an optional
 * fuzzy name term. Input parses leniently through the registry — invalid
 * entries drop into `issues`, echoed in the response for the caller's
 * correction loop (Phase B model, UI). `q` matches current organisation names
 * and previous Companies House names on the same terms as the home search
 * (shared fragments in lib/search/prev-name), so a renamed sponsor stays
 * findable under its old name once filters are applied; the filters then apply
 * to the company as it is today.
 * Response depends only on input, so it edge-caches for 5 minutes.
 */
export const searchFiltered = createServerFn()
  .validator((input: unknown) => input as { params: unknown; offset?: number })
  .handler(async ({ data: { params, offset } }) => {
    setRpcCacheControl(SHORT_EDGE_CACHE);
    return runFilteredSearch(params, offset);
  });

/**
 * The same listing restricted to the ask's ranked companies, in rank order
 * (lib/search/ranked). It exists only to serve the ask, so it is gated as the
 * ask is (lib/ask/access.server): a request that may not ask lists nothing.
 * The ids travel in a POST body, never a URL, and the response is private:
 * it is one visitor's answer.
 */
export const searchRanked = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const { params, offset, companyNumbers } = input as Record<string, unknown>;
    const ranked = rankedIds(companyNumbers);
    if (!ranked) throw new Error('Invalid input');
    return { params, offset: offset as number | undefined, ranked };
  })
  .handler(async ({ data: { params, offset, ranked } }) => {
    setRpcCacheControl('private, no-store');
    if (!(await mayAsk()))
      return { rows: [] as FilterSearchRow[], hasMore: false, issues: [] };
    return runFilteredSearch(params, offset, ranked);
  });

/** One page of the filtered listing; with `ranked`, only those companies, in that order. */
async function runFilteredSearch(
  params: unknown,
  offset: number | undefined,
  ranked?: string[],
) {
  const { filters, issues } = parseSearchFilters(params);
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  if (safeOffset > MAX_OFFSET) {
    // Terminal empty page: clamping and re-serving page 200 would feed the
    // infinite query identical pages forever (hasMore never goes false).
    return { rows: [] as FilterSearchRow[], hasMore: false, issues };
  }
  console.log(
    `[Filter Search] keys=${Object.keys(filters).join(',') || 'none'} offset=${safeOffset}`,
  );

  // The name term enters through the CTEs (lib/search/prev-name), not the
  // WHERE: it must match previous Companies House names too, and folding
  // that into the filter conditions as an OR costs every index.
  const name = buildNameTermSql(filters.q);
  const restriction = ranked ? rankedRestriction(ranked) : null;
  const conds = restriction
    ? [...buildFilterConditions(filters), restriction.cond]
    : buildFilterConditions(filters);
  const where = conds.length
    ? sql`WHERE ${sql.join(conds, sql` AND `)}`
    : sql``;

  // relevance is only reachable with q (parse drops it otherwise); the
  // defaults are the registry's, shared with the chips that describe them.
  const { sort: sortKey, order } = listingOrder(filters);
  const dir = order === 'desc' ? sql`DESC` : sql`ASC`;
  // Aggregated now that rows group by name_slug: a bare organisation_name is
  // no longer grouped. min(h.hash) tail keeps OFFSET pages stable. Only
  // relevance ranks by score, so it alone demotes previous-name wins
  // (the home search's `prev_won` key); name/incorporated are reachable with
  // a term too, and there previous-name hits just interleave by their column.
  // A sort the question or the base asked for orders the ranked rows too,
  // and pins the walk to its first slice (lib/ask/outcome), so the order
  // never restarts at a slice boundary; the rank order stands in only when
  // none was.
  const orderBy =
    restriction && !orderAsked(filters)
      ? restriction.orderBy
      : sortKey === 'relevance'
        ? sql`score DESC, ${name.prevWon} ASC, min(h.organisation_name) ASC, min(h.hash) ASC`
        : sortKey === 'incorporated'
          ? sql`c.date_of_creation ${dir} NULLS LAST, min(h.organisation_name) ASC, min(h.hash) ASC`
          : sql`min(h.organisation_name) ${dir}, min(h.hash) ASC`;

  // Licence rows merge per company (org, slug): routes/ratings aggregate,
  // and route/rating filters shape the aggregate — the chip reflects the
  // rows that matched. c.* columns are grouped via c.company_number (PK →
  // functional dependency); array_to_json so the driver always hands back
  // JS arrays regardless of its text[] type parsers.
  const result = await db.execute(sql`
    ${name.ctes}
    SELECT min(h.hash) AS "slugId",
           -- Elected exactly as searchHmrc and the page elect their primary:
           -- mapped first, then lowest company number, then name.
           (array_agg(h.organisation_name ORDER BY
              (m.company_number IS NULL) ASC, m.company_number ASC,
              h.organisation_name ASC
            ))[1] AS "organisationName",
           h.name_slug AS "nameSlug",
           COALESCE(c.locality, c.address_line_2) AS "locality",
           c.region AS "region",
           array_to_json(array_agg(DISTINCT h.type_rating ORDER BY h.type_rating)) AS "typeRatings",
           array_to_json(array_agg(DISTINCT h.route ORDER BY h.route)) AS "routes",
           -- The PAIRED rows: anything showing a route and rating together
           -- must read them from here, not from the two sorted lists above.
           array_to_json(array_agg(DISTINCT jsonb_build_object(
             'route', h.route, 'rating', h.type_rating))) AS "licences",
           ${name.score} AS "score",
           ${name.matchedPrev} AS "matchedPreviousName",
           c.company_status AS "companyStatus",
           c.date_of_creation AS "incorporatedOn",
           (SELECT sc.description FROM ${sicCodes} sc WHERE sc.code = c.sic_codes[1]) AS "sicPrimary"
    FROM ${name.source}
    LEFT JOIN ${hmrcCompanyMapping} m ON m.organisation_name = h.organisation_name
    LEFT JOIN ${companiesHouseProfiles} c ON c.company_number = m.company_number
    ${name.prevJoin}
    ${where}
    -- One card per URL, matching searchHmrc: grouping per organisation_name
    -- left a company's case-variant register rows as separate, identical
    -- cards that all open the same page (314 slugs) in browse mode only.
    GROUP BY h.name_slug, c.company_number
    ORDER BY ${orderBy}
    LIMIT ${PAGE_SIZE + 1} OFFSET ${safeOffset}
  `);
  const raw = result.rows as FilterSearchRow[];

  const hasMore = raw.length > PAGE_SIZE;
  const rows = raw.slice(0, PAGE_SIZE);

  return { rows, hasMore, issues };
}
