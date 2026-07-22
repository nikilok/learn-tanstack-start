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
 * shrinks results. Keep both halves (see CLAUDE.md "Home search").
 */
export function buildNameMatchers(query: string) {
  const regexEscaped = escapeRegex(query);
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
  return { fuzzyMatch, scoreCase };
}
