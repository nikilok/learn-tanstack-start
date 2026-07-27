import {
  chPreviousNames,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
} from '@ss/db';
import { type SQL, sql } from 'drizzle-orm';

import { buildNameMatchers } from './name-match';

// Fragments target the canonical aliases every name-search query must use:
//   pm — the `prevMatches` CTE, aliased `pm` and LEFT JOINed on
//        organisation_name so a row without an old-name hit scores NULL
//   h  — the `hits` CTE, carrying the `direct` flag
// and belong in a SELECT that groups h's licence rows per company.

/**
 * Build the previous-Companies-House-name half of a name search: the old-name
 * match CTE, the direct/previous union that feeds it into a listing, and the
 * aggregate score fragments — shared by the home search (`searchHmrc`) and the
 * filtered search (`searchFiltered`) so a renamed company is found, scored and
 * demoted identically whether or not a filter is applied.
 */
export function buildPrevNameMatch(query: string) {
  const { fuzzyMatch, matchBranches, scoreCase } = buildNameMatchers(query);
  const prevName = sql`pn.name`;
  const orgName = sql`h.organisation_name`;

  // One UNION branch per operator, not one ORed WHERE: the OR loses the index
  // here (CLAUDE.md "Name search" has the measurements and the trade-off).
  // UNION is over the PK columns, so it dedupes exactly.
  const prevCandidates = sql.join(
    matchBranches(prevName).map(
      (branch) =>
        sql`SELECT pn.company_number, pn.name FROM ${chPreviousNames} pn WHERE ${branch}`,
    ),
    sql` UNION `,
  );

  // public_body/no_match mapping rows have a NULL company_number, so they drop
  // out of this join naturally.
  const prevMatches = sql`
        SELECT m.organisation_name,
               (array_agg(pn.name ORDER BY ${scoreCase(prevName)} DESC, pn.name ASC))[1] AS matched_name,
               max(${scoreCase(prevName)}) AS prev_score
        FROM (${prevCandidates}) pn
        JOIN ${hmrcCompanyMapping} m ON m.company_number = pn.company_number
        GROUP BY m.organisation_name`;

  // Old-name hits get their own branch; OR-ing them into the direct WHERE
  // would force a seq scan. `h.*` is load-bearing — it is what makes any
  // sponsor column resolvable to a caller's WHERE (buildFilterConditions reads
  // h.town_city), so narrowing this projection breaks the filtered search.
  // UNION can't collapse `direct`; the consumer's GROUP BY merges the pair.
  const hits = sql`
        SELECT h.*, true AS direct
        FROM ${hmrcSkilledWorkers} h
        WHERE ${fuzzyMatch(orgName)}
        UNION
        SELECT h.*, false AS direct
        FROM ${hmrcSkilledWorkers} h
        JOIN pm ON pm.organisation_name = h.organisation_name`;

  return {
    prevMatches,
    hits,
    // Gated on a real direct match: ungated, a previous-name-only row scores
    // sub-threshold noise that suppresses its "Previously" line. Keep the flag
    // — a fuzzyMatch recheck here re-runs trigram ops per grouped row.
    orgScore: sql`CASE WHEN bool_or(h.direct) THEN max(${scoreCase(orgName)}) ELSE 0 END`,
    prevScore: sql`max(pm.prev_score)`,
    // Best previous-name match across the merged name variants.
    bestPrevName: sql`(array_agg(pm.matched_name ORDER BY
                  pm.prev_score DESC NULLS LAST, pm.matched_name ASC
                ))[1]`,
  };
}

/**
 * Rank one name search from its two score sources: the better of the two wins,
 * a previous-name win is demoted below an equal-scoring direct hit, and the old
 * name surfaces only when it strictly beats the current one. Both surfaces MUST
 * route through this — the rules are the ranking, and a second copy would let
 * one listing disagree with the other about the same company. Operands take
 * either the aggregates (grouping query) or the columns they landed in (a
 * later CTE), and each is parenthesised so no caller's expression can bind
 * loosely inside the `>` or the ORDER BY item it is spliced into.
 */
export function composeNameScores(parts: {
  org: SQL;
  prev: SQL;
  matched: SQL;
}) {
  const prev = sql`coalesce(${parts.prev}, 0)`;
  const won = sql`((${prev}) > (${parts.org}))`;
  return {
    score: sql`GREATEST((${parts.org}), (${prev}))`,
    // Demotes previous-name wins below same-score direct hits: they tie prefix
    // queries at full score but would tie-break by their unrelated current
    // name, flooding page 1 (e.g. 'london').
    prevWon: won,
    matchedPrev: sql`CASE WHEN ${won} THEN ${parts.matched} END`,
  };
}

/**
 * Compose the name-term half of a single-level grouped sponsor listing (the
 * filtered search): the CTEs, the FROM source and join they add, and the
 * aggregate score, demotion and matched-name expressions. Without a term it
 * degrades to browsing the register — no CTEs, no score, no previous name.
 */
export function buildNameTermSql(query: string | undefined) {
  if (!query) {
    return {
      ctes: sql``,
      source: sql`${hmrcSkilledWorkers} h`,
      prevJoin: sql``,
      score: sql`0`,
      // NULL, not `false`: Postgres rejects a bare constant as an ORDER BY key
      // (42601), and this is handed to a caller that sorts on it.
      prevWon: sql`NULL::boolean`,
      matchedPrev: sql`NULL::text`,
    };
  }

  const { prevMatches, hits, orgScore, prevScore, bestPrevName } =
    buildPrevNameMatch(query);
  return {
    ctes: sql`WITH pm AS (${prevMatches}
      ),
      hits AS (${hits}
      )`,
    source: sql`hits h`,
    prevJoin: sql`LEFT JOIN pm ON pm.organisation_name = h.organisation_name`,
    ...composeNameScores({
      org: orgScore,
      prev: prevScore,
      matched: bestPrevName,
    }),
  };
}
