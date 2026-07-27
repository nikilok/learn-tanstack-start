import { describe, expect, test } from 'bun:test';

import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { buildNameMatchers } from './name-match';
import { buildNameTermSql, buildPrevNameMatch } from './prev-name';

const dialect = new PgDialect();

/** Render a fragment to SQL text + bound params, collapsing only line breaks. */
function render(fragment: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment);
  return {
    text: query.sql.replace(/\s*\n\s*/g, ' ').trim(),
    params: query.params,
  };
}

/** Render with param slots anonymised, so fragments compare independent of their position. */
const shape = (fragment: SQL) => render(fragment).text.replace(/\$\d+/g, '?');

describe('buildPrevNameMatch', () => {
  test('previous names are probed as UNIONed index branches, never one ORed scan', () => {
    // The regression this locks: ch_previous_names is small enough that an
    // ORed predicate costs below a BitmapOr, so the planner seq-scans and runs
    // the regex per row — 300ms where three index probes cost 14ms.
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

  test('the current-name score is gated on a real direct match', () => {
    // Ungated, a previous-name-only row scores sub-threshold word_similarity
    // noise, which suppresses its "Previously" line and beats the demotion.
    expect(shape(buildPrevNameMatch('acme').orgScore)).toBe(
      'CASE WHEN bool_or(h.direct) THEN max(CASE WHEN h.organisation_name ~* ? THEN 2.0 + word_similarity(?, h.organisation_name) WHEN h.organisation_name ~* ? THEN 1.0 + word_similarity(?, h.organisation_name) ELSE word_similarity(?, h.organisation_name) END) ELSE 0 END',
    );
  });

  test('the surfaced previous name is the best-scoring one across variants', () => {
    expect(shape(buildPrevNameMatch('acme').bestPrevName)).toBe(
      '(array_agg(pm.matched_name ORDER BY pm.prev_score DESC NULLS LAST, pm.matched_name ASC ))[1]',
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
    expect(render(none.prevWon)).toEqual({ text: 'false', params: [] });
    expect(render(none.matchedPrev)).toEqual({
      text: 'NULL::text',
      params: [],
    });
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

  test('score takes the better of the current and previous name', () => {
    const term = buildNameTermSql('acme');
    expect(shape(term.score)).toBe(
      `GREATEST(${shape(buildPrevNameMatch('acme').orgScore)}, coalesce(max(pm.prev_score), 0))`,
    );
  });

  test('a previous-name win is demoted below an equal-scoring direct hit', () => {
    // Strictly greater, not >=: on a tie the direct match sorts first and the
    // card shows the current name alone.
    const shapeOf = shape(buildNameTermSql('acme').prevWon);
    expect(shapeOf.startsWith('coalesce(max(pm.prev_score), 0) > ')).toBe(true);
    expect(shapeOf).not.toContain('>=');
  });

  test('the "Previously" name is surfaced on the same strict comparison', () => {
    const term = buildNameTermSql('acme');
    expect(shape(term.matchedPrev)).toBe(
      `CASE WHEN ${shape(term.prevWon)} THEN ${shape(buildPrevNameMatch('acme').bestPrevName)} END`,
    );
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
