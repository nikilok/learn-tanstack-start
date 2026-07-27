import {
  chPreviousNames,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
} from '@ss/db';
import { sql } from 'drizzle-orm';

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

  // One UNION branch per match operator, NOT the single ORed predicate:
  // ch_previous_names is small enough (48k rows / 800 pages) that the planner
  // costs a seq scan below the BitmapOr and then pays the regex + trigram
  // filter on every row — 300ms where three index probes cost 14ms. The UNION
  // is over the table's PK columns, so it dedupes exactly. Do NOT fold these
  // back into a WHERE; re-measure with EXPLAIN if the table ever grows.
  const prevCandidates = sql.join(
    matchBranches(prevName).map(
      (branch) =>
        sql`SELECT pn.company_number, pn.name FROM ${chPreviousNames} pn WHERE ${branch}`,
    ),
    sql` UNION `,
  );

  // Previous names live in `ch_previous_names` — a trigram-indexed projection
  // of companies_house_profiles.previous_company_names, because GIN can't
  // index inside an array column. public_body/no_match mapping rows have a
  // NULL company_number and drop out of the join naturally.
  const prevMatches = sql`
        SELECT m.organisation_name,
               (array_agg(pn.name ORDER BY ${scoreCase(prevName)} DESC, pn.name ASC))[1] AS matched_name,
               max(${scoreCase(prevName)}) AS prev_score
        FROM (${prevCandidates}) pn
        JOIN ${hmrcCompanyMapping} m ON m.company_number = pn.company_number
        GROUP BY m.organisation_name`;

  // Old-name hits stay in their own UNION branch (probing idx_hmrc_org_name by
  // org) rather than OR-ing into the direct WHERE — an OR across the join
  // forces a seq scan and loses all index use. `h.*` so a caller's WHERE can
  // filter on any sponsor column (buildFilterConditions reads h.town_city).
  // UNION can't collapse the `direct` flag, so a company matching both ways
  // yields two rows: the consumer's GROUP BY merges them under bool_or.
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
    // Gate the current-name score on a real direct match (the flag is free at
    // WHERE time): for previous-name-only rows scoreCase is sub-threshold
    // word_similarity noise that would suppress the "Previously" line and leak
    // past the prev-name demotion. Do NOT swap the flag for a fuzzyMatch
    // recheck here — that re-runs trigram ops per grouped row.
    orgScore: sql`CASE WHEN bool_or(h.direct) THEN max(${scoreCase(orgName)}) ELSE 0 END`,
    prevScore: sql`max(pm.prev_score)`,
    // Best previous-name match across the merged name variants.
    bestPrevName: sql`(array_agg(pm.matched_name ORDER BY
                  pm.prev_score DESC NULLS LAST, pm.matched_name ASC
                ))[1]`,
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
      prevWon: sql`false`,
      matchedPrev: sql`NULL::text`,
    };
  }

  const { prevMatches, hits, orgScore, prevScore, bestPrevName } =
    buildPrevNameMatch(query);
  const prev = sql`coalesce(${prevScore}, 0)`;
  return {
    ctes: sql`WITH pm AS (${prevMatches}
      ),
      hits AS (${hits}
      )`,
    source: sql`hits h`,
    prevJoin: sql`LEFT JOIN pm ON pm.organisation_name = h.organisation_name`,
    score: sql`GREATEST(${orgScore}, ${prev})`,
    // Demotes previous-name wins below same-score direct hits: they tie prefix
    // queries at full score but would tie-break by their unrelated current
    // name, flooding page 1 (e.g. 'london').
    prevWon: sql`${prev} > ${orgScore}`,
    // The "Previously …" line, shown only when the old name strictly beats the
    // current one — a tie shows the current name alone.
    matchedPrev: sql`CASE WHEN ${prev} > ${orgScore} THEN ${bestPrevName} END`,
  };
}
