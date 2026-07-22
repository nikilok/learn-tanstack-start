import { describe, expect, test } from 'bun:test';

import {
  parseSearchFilters,
  RATINGS,
  requiresChLink,
  TYPE_RATING_ROWS,
  typeRatingsFor,
  WORKER_TYPES,
} from './params';

describe('parseSearchFilters', () => {
  test('parses a full valid param set with lenient spellings', () => {
    const { filters, issues } = parseSearchFilters({
      q: ' Tesco ',
      route: 'skilled-worker,Charity Worker',
      workerType: 'temporary',
      rating: ['a', 'sme+'],
      location: '  Milton   Keynes ',
      sic: ['62020', '62012'],
      sicSection: 'j',
      status: 'Active',
      companyType: 'LTD',
      incorporatedFrom: 2015,
      incorporatedTo: '2020-06-30',
      accountsOverdue: 'false',
      hasCharges: true,
      hasRenamed: 'true',
      hasMoved: false,
      sort: 'Relevance',
      order: 'DESC',
    });
    expect(issues).toEqual([]);
    expect(filters).toEqual({
      q: 'Tesco',
      route: ['Skilled Worker', 'Charity Worker'],
      workerType: ['Temporary Worker'],
      rating: ['A', 'A-SME+'],
      location: 'Milton Keynes',
      sic: ['62020', '62012'],
      sicSection: ['J'],
      status: ['active'],
      companyType: ['ltd'],
      incorporatedFrom: '2015-01-01',
      incorporatedTo: '2020-06-30',
      accountsOverdue: false,
      hasCharges: true,
      hasRenamed: true,
      hasMoved: false,
      sort: 'relevance',
      order: 'desc',
    });
  });

  test('drops a short q with an issue; blank q is silently absent', () => {
    const short = parseSearchFilters({ q: 'ab' });
    expect(short.filters.q).toBeUndefined();
    expect(short.issues).toEqual(['q: needs at least 3 characters — dropped']);
    const blank = parseSearchFilters({ q: '   ' });
    expect(blank.filters).toEqual({});
    expect(blank.issues).toEqual([]);
  });

  test('truncates an over-long q at 100 code points with an issue', () => {
    const long = parseSearchFilters({ q: `${'a'.repeat(99)}💥end` });
    expect(long.filters.q).toBe(`${'a'.repeat(99)}💥`);
    expect(long.issues).toEqual(['q: over 100 characters — truncated']);
  });

  test('drops unknown enum values, keeps valid ones, dedupes', () => {
    const { filters, issues } = parseSearchFilters({
      route: 'Skilled Worker,Space Cadet,skilled worker',
    });
    expect(filters.route).toEqual(['Skilled Worker']);
    expect(issues).toEqual(['route: unknown value "Space Cadet" — dropped']);
    const none = parseSearchFilters({ route: 'Space Cadet' });
    expect(none.filters.route).toBeUndefined();
    // No phantom own-property either — Object.entries consumers must see nothing.
    expect('route' in none.filters).toBe(false);
  });

  test('clips long values echoed in issue messages', () => {
    const { issues } = parseSearchFilters({ sort: 'x'.repeat(100) });
    expect(issues).toEqual([
      `sort: unknown value "${'x'.repeat(40)}…" — dropped`,
    ]);
  });

  test('null or non-object input parses as no filters', () => {
    expect(parseSearchFilters(null)).toEqual({ filters: {}, issues: [] });
    expect(parseSearchFilters(undefined)).toEqual({ filters: {}, issues: [] });
    expect(parseSearchFilters('junk').issues).toEqual([
      'input: expected an object of filter params — ignored',
    ]);
  });

  test('rejects prototype-chain keys in alias lookups', () => {
    const { filters, issues } = parseSearchFilters({ rating: 'constructor' });
    expect(filters.rating).toBeUndefined();
    expect(issues).toEqual(['rating: unknown value "constructor" — dropped']);
    const wt = parseSearchFilters({ workerType: 'toString' });
    expect(wt.filters.workerType).toBeUndefined();
    expect(wt.issues).toEqual([
      'workerType: unknown value "toString" — dropped',
    ]);
  });

  test('expands bare years and swaps a reversed range onto its outer edges', () => {
    const { filters, issues } = parseSearchFilters({
      incorporatedFrom: '2020',
      incorporatedTo: '2015',
    });
    expect(filters.incorporatedFrom).toBe('2015-01-01');
    expect(filters.incorporatedTo).toBe('2020-12-31');
    expect(issues).toEqual([
      'incorporatedFrom/incorporatedTo: reversed range — swapped',
    ]);
    const mixed = parseSearchFilters({
      incorporatedFrom: '2020-06-15',
      incorporatedTo: '2015',
    });
    expect(mixed.filters.incorporatedFrom).toBe('2015-01-01');
    expect(mixed.filters.incorporatedTo).toBe('2020-06-15');
  });

  test('rejects impossible calendar dates and year 0000', () => {
    const bad = parseSearchFilters({ incorporatedFrom: '2015-02-30' });
    expect(bad.filters.incorporatedFrom).toBeUndefined();
    expect(bad.issues).toEqual([
      'incorporatedFrom: invalid date "2015-02-30" — dropped',
    ]);
    const yearZero = parseSearchFilters({ incorporatedFrom: '0000' });
    expect(yearZero.filters.incorporatedFrom).toBeUndefined();
    expect(yearZero.issues).toEqual([
      'incorporatedFrom: invalid date "0000" — dropped',
    ]);
    const dateZero = parseSearchFilters({ incorporatedTo: '0000-01-01' });
    expect(dateZero.filters.incorporatedTo).toBeUndefined();
    expect(dateZero.issues).toEqual([
      'incorporatedTo: invalid date "0000-01-01" — dropped',
    ]);
  });

  test('drops relevance sort without q, keeps it with q', () => {
    const dropped = parseSearchFilters({ sort: 'relevance' });
    expect(dropped.filters.sort).toBeUndefined();
    expect(dropped.issues).toEqual(['sort: relevance requires q — dropped']);
    const kept = parseSearchFilters({ q: 'abc', sort: 'relevance' });
    expect(kept.filters.sort).toBe('relevance');
    expect(parseSearchFilters({ sort: 'name' }).filters.sort).toBe('name');
  });

  test('accepts the first element when a scalar param arrives as an array', () => {
    const { filters, issues } = parseSearchFilters({
      sort: ['incorporated'],
      order: ['asc'],
      location: ['Leeds'],
    });
    expect(filters.sort).toBe('incorporated');
    expect(filters.order).toBe('asc');
    expect(filters.location).toBe('Leeds');
    expect(issues).toEqual([]);
    // Dropped extras are reported, not silently discarded.
    const multi = parseSearchFilters({ location: ['Leeds', 'London'] });
    expect(multi.filters.location).toBe('Leeds');
    expect(multi.issues).toEqual([
      'location: multiple values — using the first',
    ]);
  });

  test('industry collapses whitespace and needs a distinctive word', () => {
    const ok = parseSearchFilters({ industry: '  care   homes ' });
    expect(ok.filters.industry).toBe('care homes');
    expect(ok.issues).toEqual([]);
    for (const junkInput of ['IT & Co', 'and the other']) {
      const junk = parseSearchFilters({ industry: junkInput });
      expect(junk.filters.industry).toBeUndefined();
      expect(junk.issues).toEqual([
        'industry: needs a distinctive word of 3+ characters — dropped',
      ]);
    }
  });

  test('coerces boolean strings and reports junk; null/empty means unset', () => {
    const ok = parseSearchFilters({ hasMoved: 'True' });
    expect(ok.filters.hasMoved).toBe(true);
    const junk = parseSearchFilters({ accountsOverdue: 'yes' });
    expect(junk.filters.accountsOverdue).toBeUndefined();
    expect(junk.issues).toEqual([
      'accountsOverdue: expected true/false — dropped',
    ]);
    const unset = parseSearchFilters({ hasMoved: null, hasCharges: '' });
    expect(unset.filters).toEqual({});
    expect(unset.issues).toEqual([]);
  });

  test('validates sic codes individually and accepts numeric entries', () => {
    const { filters, issues } = parseSearchFilters({
      sic: '62020, 999, potato',
    });
    expect(filters.sic).toEqual(['62020']);
    expect(issues).toEqual([
      'sic: invalid code "999" — dropped',
      'sic: invalid code "potato" — dropped',
    ]);
    const numeric = parseSearchFilters({ sic: 62020 });
    expect(numeric.filters.sic).toEqual(['62020']);
    expect(numeric.issues).toEqual([]);
    const mixed = parseSearchFilters({ sic: [62020, '62012'] });
    expect(mixed.filters.sic).toEqual(['62020', '62012']);
  });

  test('caps list params and the issues echo', () => {
    const codes = Array.from({ length: 60 }, (_, i) => String(10000 + i));
    const { filters, issues } = parseSearchFilters({ sic: codes });
    expect(filters.sic).toHaveLength(50);
    expect(issues).toEqual(['sic: more than 50 values — extras dropped']);
    const junk = parseSearchFilters({
      route: Array.from({ length: 40 }, (_, i) => `junk${i}`).join(','),
    });
    expect(junk.issues).toHaveLength(26);
    expect(junk.issues.at(-1)).toBe('…additional issues dropped');
  });

  test('ignores unknown keys silently', () => {
    const { filters, issues } = parseSearchFilters({
      q: 'abc',
      offset: 50,
      foo: 'bar',
    });
    expect(filters).toEqual({ q: 'abc' });
    expect(issues).toEqual([]);
  });
});

describe('typeRatingsFor', () => {
  test('facets intersect and map to raw feed values', () => {
    expect(typeRatingsFor(['Worker'])).toHaveLength(5);
    expect(typeRatingsFor(undefined, ['A-SME+'])).toEqual([
      'Worker (A (SME+))',
      'Temporary Worker (A (SME+))',
    ]);
    // Pin the feed's trailing space — an IN-list equality depends on it.
    expect(typeRatingsFor(['Worker'], ['Provisional'])).toEqual([
      'Worker (UK Expansion Worker: Provisional )',
    ]);
  });

  test('an impossible combination yields no raw values', () => {
    expect(typeRatingsFor(['Temporary Worker'], ['Provisional'])).toEqual([]);
  });

  test('rows cover every canonical facet value', () => {
    expect(new Set(TYPE_RATING_ROWS.map((r) => r.workerType))).toEqual(
      new Set(WORKER_TYPES),
    );
    expect(new Set(TYPE_RATING_ROWS.map((r) => r.rating))).toEqual(
      new Set(RATINGS),
    );
    expect(new Set(TYPE_RATING_ROWS.map((r) => r.raw)).size).toBe(
      TYPE_RATING_ROWS.length,
    );
  });
});

describe('requiresChLink', () => {
  test('true only for Companies-House-sourced filters', () => {
    expect(
      requiresChLink({ route: ['Skilled Worker'], location: 'London' }),
    ).toBe(false);
    expect(requiresChLink({ hasMoved: false })).toBe(true);
    expect(requiresChLink({ status: ['active'] })).toBe(true);
    // industry/sic read c.sic_codes, so they drop unmapped sponsors too.
    expect(requiresChLink({ industry: 'software' })).toBe(true);
    expect(requiresChLink({ sic: ['62020'] })).toBe(true);
    expect(requiresChLink({ sicSection: ['J'] })).toBe(true);
  });
});
