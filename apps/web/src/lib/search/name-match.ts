import { type SQL, sql } from 'drizzle-orm';

/** Regex-escape a raw search query for safe use inside ~* patterns. */
export function escapeRegex(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the fuzzy-match predicate and ranking-CASE factories for one search
 * query, shared by searchHmrc and the /search filter fn so an optional name
 * term scores identically everywhere. Each predicate pairs an index-served
 * trigram OPERATOR with a function recheck (`<%` + word_similarity, `%` +
 * similarity): the operators let the GIN trigram indexes BitmapOr the
 * candidate set (~20x faster than bare function calls), while the rechecks
 * pin the exact thresholds against downward pg_trgm GUC drift. NOT immune
 * upward: a GUC raised above 0.6/0.5 becomes the binding filter and silently
 * shrinks results. Keep both halves (see CLAUDE.md "Name search").
 */
export function buildNameMatchers(query: string) {
  const regexEscaped = escapeRegex(query);
  const wordBoundaryPattern = `\\m${regexEscaped}`;
  const prefixPattern = `^${regexEscaped}`;
  /**
   * The three match branches, each an index-served operator plus its threshold
   * recheck. Single source for both the ORed predicate and the UNION form, so
   * the two can never match different rows.
   */
  const matchBranches = (col: SQL): SQL[] => [
    sql`${col} ~* ${wordBoundaryPattern}`,
    sql`${query} <% ${col} AND word_similarity(${query}, ${col}) > 0.6`,
    sql`${col} % ${query} AND similarity(${query}, ${col}) > 0.5`,
  ];
  /**
   * Fuzzy match for a name column as one ORed predicate. Only safe on a table
   * big enough that the planner costs a seq scan above the BitmapOr — on a
   * small one it silently picks the scan and pays the filter per row. Where
   * that happens, UNION the branches instead (see lib/search/prev-name).
   */
  const fuzzyMatch = (col: SQL) =>
    sql`(${sql.join(
      matchBranches(col).map((branch) => sql`(${branch})`),
      sql` OR `,
    )})`;
  /** Ranking CASE for a name column: prefix > word-boundary > similarity. */
  const scoreCase = (col: SQL) => sql`CASE
      WHEN ${col} ~* ${prefixPattern} THEN 2.0 + word_similarity(${query}, ${col})
      WHEN ${col} ~* ${wordBoundaryPattern} THEN 1.0 + word_similarity(${query}, ${col})
      ELSE word_similarity(${query}, ${col})
    END`;
  return { fuzzyMatch, matchBranches, scoreCase };
}
