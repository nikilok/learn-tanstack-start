import { describe, expect, test } from 'bun:test';

import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { buildNameMatchers } from './name-match';
import {
  buildNameTermSql,
  buildPrevNameMatch,
  composeNameScores,
} from './prev-name';

const dialect = new PgDialect();

/** Render a fragment to SQL text + bound params, collapsing only line breaks. */
function render(fragment: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment);
  return {
    text: query.sql.replace(/\s*\n\s*/g, ' ').trim(),
    params: query.params,
  };
}

/**
 * Render with param slots anonymised and whitespace normalised, so fragments
 * compare on structure — reindenting SQL is invisible to Postgres and must be
 * invisible here too.
 */
const shape = (fragment: SQL) =>
  render(fragment)
    .text.replace(/\$\d+/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\s+\)/g, ')')
    .trim();

describe('buildPrevNameMatch', () => {
  test('previous names are probed as UNIONed index branches, never one ORed scan', () => {
    // Locks the shape, not a timing: ORed, the planner seq-scans this table
    // and runs the regex per row for a selective term (287ms vs 13ms for
    // 'london'). CLAUDE.md "Name search" carries the full trade-off.
    const { text } = render(buildPrevNameMatch('acme').prevMatches);
    const branches = text.match(/FROM "ch_previous_names" pn WHERE/g) ?? [];
    expect(branches).toHaveLength(3);
    expect(text.match(/ UNION /g)).toHaveLength(2);
    expect(text).not.toContain(' OR ');
  });

  test('the previous-name union dedupes on the table primary key', () => {
    // (company_number, name) is the PK, so UNION collapses a name matched by
    // more than one branch without dropping a distinct row.
    const { text } = render(buildPrevNameMatch('acme').prevMatches);
    expect(text.match(/SELECT pn\.company_number, pn\.name/g)).toHaveLength(3);
  });

  test('both hits arms carry the direct flag, and the second is pm-driven', () => {
    const { text } = render(buildPrevNameMatch('acme').hits);
    expect(text).toContain('SELECT h.*, true AS direct');
    expect(text).toContain('SELECT h.*, false AS direct');
    expect(text).toContain(
      'JOIN pm ON pm.organisation_name = h.organisation_name',
    );
  });

  test('hits keeps duplicates: the dedupe can only ever remove zero rows', () => {
    // The arms differ by their `direct` literal, h.id is a serial PK, and pm is
    // grouped by organisation_name — so nothing is ever collapsible. Plain
    // UNION still sorted all 78k wide tuples on a broad term (10MB to disk) to
    // discover that. Restoring it is a silent, measurable cost, never a fix.
    const { text } = render(buildPrevNameMatch('acme').hits);
    expect(text).toContain(' UNION ALL ');
    expect(text).not.toMatch(/UNION(?! ALL)/);
  });

  test('the current-name score is gated on a real direct match', () => {
    // Ungated, a previous-name-only row scores sub-threshold word_similarity
    // noise, which suppresses its "Previously" line and beats the demotion.
    const text = shape(buildPrevNameMatch('acme').orgScore);
    expect(text.startsWith('CASE WHEN bool_or(h.direct) THEN max(')).toBe(true);
    expect(text.endsWith('ELSE 0 END')).toBe(true);
    expect(text).toContain('word_similarity(?, h.organisation_name)');
  });

  test('the surfaced previous name is the best-scoring one across variants', () => {
    expect(shape(buildPrevNameMatch('acme').bestPrevName)).toBe(
      '(array_agg(pm.matched_name ORDER BY pm.prev_score DESC NULLS LAST, pm.matched_name ASC))[1]',
    );
  });
});

describe('composeNameScores', () => {
  const parts = {
    org: sql`org_score`,
    prev: sql`prev_score`,
    matched: sql`matched_name`,
  };

  test('ranks by the better of the two names', () => {
    expect(shape(composeNameScores(parts).score)).toBe(
      'GREATEST((org_score), (coalesce(prev_score, 0)))',
    );
  });

  test('demotes a previous-name win on a strict comparison', () => {
    // Strictly greater, not >=: on a tie the direct match sorts first and the
    // card shows the current name alone.
    const text = shape(composeNameScores(parts).prevWon);
    expect(text).toBe('((coalesce(prev_score, 0)) > (org_score))');
    expect(text).not.toContain('>=');
  });

  test('surfaces the old name on that same comparison, never a second rule', () => {
    const ranked = composeNameScores(parts);
    expect(shape(ranked.matchedPrev)).toBe(
      `CASE WHEN ${shape(ranked.prevWon)} THEN matched_name END`,
    );
  });

  test('every operand is parenthesised so callers can pass any expression', () => {
    // These land inside `>` and in an ORDER BY item; an operand ending in a
    // bare comparison would otherwise re-bind and throw a syntax error.
    const loose = composeNameScores({
      org: sql`a AND b`,
      prev: sql`c OR d`,
      matched: sql`e`,
    });
    expect(shape(loose.prevWon)).toBe('((coalesce(c OR d, 0)) > (a AND b))');
    expect(shape(loose.score)).toBe(
      'GREATEST((a AND b), (coalesce(c OR d, 0)))',
    );
  });
});

describe('buildNameTermSql', () => {
  test('without a term the listing browses the register directly', () => {
    // Browse mode must stay exactly the query it was: no CTEs, no join, no
    // score — anything else changes every filter-only page.
    const none = buildNameTermSql(undefined);
    expect(render(none.ctes)).toEqual({ text: '', params: [] });
    expect(render(none.prevJoin)).toEqual({ text: '', params: [] });
    expect(render(none.source)).toEqual({
      text: '"hmrc_skilled_workers" h',
      params: [],
    });
    expect(render(none.score)).toEqual({ text: '0', params: [] });
    expect(render(none.matchedPrev)).toEqual({
      text: 'NULL::text',
      params: [],
    });
  });

  test('the no-term prevWon is legal where its only consumer puts it', () => {
    // filterSearch splices this straight into `ORDER BY … ASC`, and Postgres
    // rejects a bare constant there (42601 non-integer constant in ORDER BY).
    // Unreachable today only because params.ts drops `sort=relevance` without
    // a term — this keeps the fragment valid if that guard ever moves.
    const { text } = render(buildNameTermSql(undefined).prevWon);
    expect(text).toBe('NULL::boolean');
    expect(['true', 'false']).not.toContain(text);
  });

  test('an empty term is treated as no term', () => {
    expect(render(buildNameTermSql('').ctes)).toEqual({ text: '', params: [] });
  });

  test('with a term the listing reads the hits CTE and joins the matches', () => {
    const term = buildNameTermSql('acme');
    expect(render(term.source)).toEqual({ text: 'hits h', params: [] });
    expect(render(term.prevJoin)).toEqual({
      text: 'LEFT JOIN pm ON pm.organisation_name = h.organisation_name',
      params: [],
    });
    const ctes = render(term.ctes).text;
    expect(ctes.startsWith('WITH pm AS (')).toBe(true);
    expect(ctes).toContain('), hits AS (');
  });

  test('the ranking is composeNameScores over this surface’s aggregates', () => {
    // The whole point of the shared composer: the filtered listing must not
    // hold its own copy of the GREATEST / demotion / matched-name rules, or it
    // can rank a company differently from the home search.
    const { orgScore, prevScore, bestPrevName } = buildPrevNameMatch('acme');
    const expected = composeNameScores({
      org: orgScore,
      prev: prevScore,
      matched: bestPrevName,
    });
    const term = buildNameTermSql('acme');
    expect(shape(term.score)).toBe(shape(expected.score));
    expect(shape(term.prevWon)).toBe(shape(expected.prevWon));
    expect(shape(term.matchedPrev)).toBe(shape(expected.matchedPrev));
  });
});

describe('match branch reuse', () => {
  test('the ORed predicate is built from the same branches the UNION uses', () => {
    // Structural, not an agreement test: one drifting from the other would
    // make a filtered search and the home search match different companies.
    const { fuzzyMatch, matchBranches } = buildNameMatchers('acme');
    const col = sql`h.organisation_name`;
    const branches = matchBranches(col).map((branch) => shape(branch));
    expect(shape(fuzzyMatch(col))).toBe(
      `(${branches.map((b) => `(${b})`).join(' OR ')})`,
    );
  });

  test('branches keep each index-served operator paired with its recheck', () => {
    // Dropping either half breaks a documented invariant: bare functions can
    // never use the index, bare operators drift with the pg_trgm GUCs.
    const branches = buildNameMatchers('acme').matchBranches(sql`c.name`);
    expect(branches.map((branch) => shape(branch))).toEqual([
      'c.name ~* ?',
      '? <% c.name AND word_similarity(?, c.name) > 0.6',
      'c.name % ? AND similarity(?, c.name) > 0.5',
    ]);
  });

  test('query text is regex-escaped before it reaches a pattern', () => {
    const [wordBoundary] = buildNameMatchers('a.c*e').matchBranches(
      sql`c.name`,
    );
    expect(render(wordBoundary).params).toEqual(['\\ma\\.c\\*e']);
  });
});
