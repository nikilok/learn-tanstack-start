import {
  companiesHouseProfiles,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
  sicCodes,
} from '@ss/db';
import { createServerFn } from '@tanstack/react-start';
import { type SQL, sql } from 'drizzle-orm';

import { db } from '../db.server';
import { buildNameMatchers } from '../lib/search/name-match';
import { parseSearchFilters, type SortKey } from '../lib/search/params';
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
  typeRating: string;
  route: string;
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
 * correction loop (Phase B model, UI). `q` matches current organisation
 * names only; the home search remains the deep previous-name surface.
 * Response depends only on input, so it edge-caches for 5 minutes.
 */
export const searchFiltered = createServerFn()
  .inputValidator(
    (input: unknown) => input as { params: unknown; offset?: number },
  )
  .handler(async ({ data: { params, offset } }) => {
    const { filters, issues } = parseSearchFilters(params);
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    if (safeOffset > MAX_OFFSET) {
      // Terminal empty page: clamping and re-serving page 200 would feed the
      // infinite query identical pages forever (hasMore never goes false).
      setRpcCacheControl(SHORT_EDGE_CACHE);
      return { rows: [] as FilterSearchRow[], hasMore: false, issues };
    }
    console.log(
      `[Filter Search] keys=${Object.keys(filters).join(',') || 'none'} offset=${safeOffset}`,
    );

    const conds = buildFilterConditions(filters);
    let scoreExpr: SQL = sql`0`;
    if (filters.q) {
      const { fuzzyMatch, scoreCase } = buildNameMatchers(filters.q);
      const orgName = sql`h.organisation_name`;
      conds.push(fuzzyMatch(orgName));
      scoreExpr = scoreCase(orgName);
    }
    const where = conds.length
      ? sql`WHERE ${sql.join(conds, sql` AND `)}`
      : sql``;

    // relevance is only reachable with q (parse drops it otherwise).
    const sortKey: SortKey = filters.sort ?? (filters.q ? 'relevance' : 'name');
    const order =
      filters.order ?? (sortKey === 'incorporated' ? 'desc' : 'asc');
    const dir = order === 'desc' ? sql`DESC` : sql`ASC`;
    // h.hash tail: ties must order identically across OFFSET pages.
    const orderBy =
      sortKey === 'relevance'
        ? sql`score DESC, h.organisation_name ASC, h.hash ASC`
        : sortKey === 'incorporated'
          ? sql`c.date_of_creation ${dir} NULLS LAST, h.organisation_name ASC, h.hash ASC`
          : sql`h.organisation_name ${dir}, h.hash ASC`;

    const result = await db.execute(sql`
      SELECT h.hash AS "slugId",
             h.organisation_name AS "organisationName",
             h.name_slug AS "nameSlug",
             COALESCE(c.locality, c.address_line_2) AS "locality",
             c.region AS "region",
             h.type_rating AS "typeRating",
             h.route AS "route",
             ${scoreExpr} AS "score",
             NULL::text AS "matchedPreviousName",
             c.company_status AS "companyStatus",
             c.date_of_creation AS "incorporatedOn",
             (SELECT sc.description FROM ${sicCodes} sc WHERE sc.code = c.sic_codes[1]) AS "sicPrimary"
      FROM ${hmrcSkilledWorkers} h
      LEFT JOIN ${hmrcCompanyMapping} m ON m.organisation_name = h.organisation_name
      LEFT JOIN ${companiesHouseProfiles} c ON c.company_number = m.company_number
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${PAGE_SIZE + 1} OFFSET ${safeOffset}
    `);
    const raw = result.rows as FilterSearchRow[];

    const hasMore = raw.length > PAGE_SIZE;
    const rows = raw.slice(0, PAGE_SIZE);

    setRpcCacheControl(SHORT_EDGE_CACHE);
    return { rows, hasMore, issues };
  });
