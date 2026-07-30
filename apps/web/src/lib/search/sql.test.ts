import { describe, expect, test } from 'bun:test';

import { ADDRESS_COLUMNS } from '@ss/db/constants';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { buildFilterConditions, combineFilterConditions } from './sql';

const dialect = new PgDialect();

/** Render a fragment to SQL text + bound params, collapsing only line breaks (intra-literal spacing like '  ' must survive). */
function render(fragment: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment);
  return {
    text: query.sql.replace(/\s*\n\s*/g, ' ').trim(),
    params: query.params,
  };
}

/** Build, assert exactly one condition, and render it. */
function renderOne(filters: Parameters<typeof buildFilterConditions>[0]) {
  const conds = buildFilterConditions(filters);
  expect(conds).toHaveLength(1);
  return render(conds[0]);
}

describe('buildFilterConditions', () => {
  test('route renders a bound IN list on the sponsor alias', () => {
    expect(renderOne({ route: ['Skilled Worker', 'Scale-up'] })).toEqual({
      text: 'h.route IN ($1, $2)',
      params: ['Skilled Worker', 'Scale-up'],
    });
  });

  test('workerType/rating facets expand to raw type_rating values', () => {
    expect(
      renderOne({ workerType: ['Worker'], rating: ['Provisional'] }),
    ).toEqual({
      text: 'h.type_rating IN ($1)',
      params: ['Worker (UK Expansion Worker: Provisional )'],
    });
  });

  test('an impossible facet combination renders FALSE', () => {
    expect(
      renderOne({ workerType: ['Temporary Worker'], rating: ['Provisional'] }),
    ).toEqual({ text: 'false', params: [] });
  });

  test('location segment-matches composites, both sides, display-aligned', () => {
    expect(renderOne({ location: 'Wembley, London' })).toEqual({
      text: "EXISTS (SELECT 1 FROM unnest(string_to_array(lower(concat_ws(',', h.town_city, COALESCE(c.locality, c.address_line_2))), ',')) AS stored(seg), unnest(string_to_array(lower($1), ',')) AS given(seg) WHERE replace(replace(btrim(stored.seg), '  ', ' '), '  ', ' ') = btrim(given.seg) AND btrim(given.seg) <> '')",
      params: ['Wembley, London'],
    });
  });

  test('5-digit sic codes use an array-overlap against the GIN index', () => {
    expect(renderOne({ sic: ['62020', '62012'] })).toEqual({
      text: 'c.sic_codes && ARRAY[$1, $2]::text[]',
      params: ['62020', '62012'],
    });
  });

  test('4-digit sic codes try the 0-pad and expand as class prefixes', () => {
    expect(renderOne({ sic: ['6202'] })).toEqual({
      text: "(c.sic_codes && ARRAY[$1, $2]::text[] OR c.sic_codes && (SELECT coalesce(array_agg(sc.code::text), '{}'::text[]) FROM sic_codes sc WHERE left(sc.code, 4) = ANY(ARRAY[$3]::text[])))",
      params: ['6202', '06202', '6202'],
    });
  });

  test('sic sections expand to divisions, excluding CH placeholder codes', () => {
    const { text, params } = renderOne({ sicSection: ['J'] });
    expect(text).toBe(
      "c.sic_codes && (SELECT coalesce(array_agg(sc.code::text), '{}'::text[]) FROM sic_codes sc WHERE left(sc.code, 2) = ANY(ARRAY[$1, $2, $3, $4, $5, $6]::text[]) AND sc.code NOT IN ($7, $8))",
    );
    expect(params).toEqual([
      '58',
      '59',
      '60',
      '61',
      '62',
      '63',
      '98000',
      '99999',
    ]);
  });

  test('single industry word resolves via SIC descriptions', () => {
    expect(renderOne({ industry: 'software' })).toEqual({
      text: "c.sic_codes && (SELECT coalesce(array_agg(sc.code::text), '{}'::text[]) FROM sic_codes sc WHERE (sc.description ~* $1 OR strict_word_similarity($2, sc.description) > 0.55))",
      params: ['\\msoftware', 'software'],
    });
  });

  test('short plurals stem to whole words, never 2-char prefixes', () => {
    expect(renderOne({ industry: 'ties' }).params).toEqual(['\\mtie', 'ties']);
    expect(renderOne({ industry: 'movies' }).params).toEqual([
      '\\mmovie',
      'movies',
    ]);
    expect(renderOne({ industry: 'industries' }).params).toEqual([
      '\\mindustry',
      'industries',
    ]);
  });

  test('multi-word industry prefers all-words, falls back to any-word', () => {
    const { text, params } = renderOne({ industry: 'care homes' });
    expect(text.startsWith('c.sic_codes && (CASE WHEN EXISTS (')).toBe(true);
    expect(text).toContain(') THEN (');
    expect(text).toContain(') ELSE (');
    // Stemmed word-boundary prefix (homes→home) + original word for trigram,
    // repeated across the EXISTS/THEN/ELSE subqueries.
    expect(params).toEqual([
      '\\mcare',
      'care',
      '\\mhome',
      'homes',
      '\\mcare',
      'care',
      '\\mhome',
      'homes',
      '\\mcare',
      'care',
      '\\mhome',
      'homes',
    ]);
  });

  test('sic codes and sections OR together in one condition', () => {
    const { text } = renderOne({ sic: ['86900'], sicSection: ['J'] });
    expect(text.startsWith('(c.sic_codes && ARRAY[$1]::text[] OR ')).toBe(true);
    expect(text.endsWith(')')).toBe(true);
  });

  test('date bounds cast the bound param to date', () => {
    expect(renderOne({ incorporatedFrom: '2015-01-01' })).toEqual({
      text: 'c.date_of_creation >= $1::date',
      params: ['2015-01-01'],
    });
    expect(renderOne({ incorporatedTo: '2020-12-31' })).toEqual({
      text: 'c.date_of_creation <= $1::date',
      params: ['2020-12-31'],
    });
  });

  test('boolean flags: true matches set rows, false includes unknown (NULL)', () => {
    expect(renderOne({ accountsOverdue: true })).toEqual({
      text: 'c.accounts_overdue = true',
      params: [],
    });
    expect(renderOne({ hasCharges: false })).toEqual({
      text: '(c.company_number IS NOT NULL AND c.has_charges IS NOT TRUE)',
      params: [],
    });
    expect(renderOne({ hasInsolvencyHistory: false })).toEqual({
      text: '(c.company_number IS NOT NULL AND c.has_insolvency_history IS NOT TRUE)',
      params: [],
    });
  });

  test('hasRenamed reads previous-name cardinality', () => {
    expect(renderOne({ hasRenamed: true }).text).toBe(
      'cardinality(c.previous_company_names) > 0',
    );
    expect(renderOne({ hasRenamed: false }).text).toBe(
      'cardinality(c.previous_company_names) = 0',
    );
  });

  test('hasMoved probes real address changes only', () => {
    const { text, params } = renderOne({ hasMoved: true });
    // Column list must render as LITERALS: the partial index's predicate is
    // only provable against constants, not bound params.
    expect(text).toBe(
      `EXISTS (SELECT 1 FROM companies_house_profile_trails t WHERE t.company_number = c.company_number AND t.column_name IN (${ADDRESS_COLUMNS.map((c) => `'${c}'`).join(', ')}) AND t.old_value IS NOT NULL AND t.new_value IS NOT NULL AND t.old_value <> t.new_value AND t.old_value NOT ILIKE '%companies house default address%' AND t.new_value NOT ILIKE '%companies house default address%')`,
    );
    expect(params).toEqual([]);
  });

  test('hasMoved=false guards the CH link so unmapped sponsors stay excluded', () => {
    const { text } = renderOne({ hasMoved: false });
    expect(
      text.startsWith('(c.company_number IS NOT NULL AND NOT EXISTS ('),
    ).toBe(true);
  });

  test('hasWebsite probes the same gate the detail page renders', () => {
    const { text, params } = renderOne({ hasWebsite: true });
    // The four conditions come from publishableWebsiteGate, so this assertion
    // is what fails if the filter and the company page ever drift apart.
    expect(text).toBe(
      'EXISTS (SELECT 1 FROM "company_websites" WHERE "company_websites"."company_number" = c.company_number AND ("company_websites"."status" = $1 and "company_websites"."checked_at" is not null and "company_websites"."evidence" in ($2, $3) and "company_websites"."url" is not null))',
    );
    // Evidence tiers are bound params, never inlined, so the allow-list can
    // never be widened by a string that reached the query builder.
    expect(params).toEqual(['verified', 'manual', 'crn_on_page']);
  });

  test('hasWebsite=false guards the CH link so unmapped sponsors stay excluded', () => {
    // NOT EXISTS over a NULL company_number is vacuously true, which would
    // otherwise sweep in every sponsor we have no Companies House link for.
    const { text } = renderOne({ hasWebsite: false });
    expect(
      text.startsWith('(c.company_number IS NOT NULL AND NOT EXISTS ('),
    ).toBe(true);
  });

  test('non-condition params contribute nothing', () => {
    expect(
      buildFilterConditions({ q: 'tesco', sort: 'name', order: 'asc' }),
    ).toEqual([]);
  });
});

describe('combineFilterConditions', () => {
  test('undefined when no filter is active', () => {
    expect(combineFilterConditions({})).toBeUndefined();
  });

  test('AND-joins active conditions in registry order', () => {
    const combined = combineFilterConditions({
      route: ['Skilled Worker'],
      status: ['active'],
      hasRenamed: true,
    });
    expect(combined).toBeDefined();
    const { text, params } = render(combined as SQL);
    expect(text).toBe(
      'h.route IN ($1) AND c.company_status IN ($2) AND cardinality(c.previous_company_names) > 0',
    );
    expect(params).toEqual(['Skilled Worker', 'active']);
  });
});
