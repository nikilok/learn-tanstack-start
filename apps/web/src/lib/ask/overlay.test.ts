import { describe, expect, test } from 'bun:test';

import {
  applyOverlay,
  applyPlan,
  describeFilters,
  describeSector,
} from './overlay';

describe('applyOverlay', () => {
  test('the plan wins per key and the base keeps everything else', () => {
    expect(
      applyOverlay(
        { location: 'London', rating: 'A' },
        { location: 'Manchester', sicSection: 'J' },
      ),
    ).toEqual({ location: 'Manchester', rating: 'A', sicSection: 'J' });
    expect(applyOverlay({}, { hasWebsite: true })).toEqual({
      hasWebsite: true,
    });
  });

  test('false is a value: it overrides and survives the merge', () => {
    expect(applyOverlay({ hasCharges: true }, { hasCharges: false })).toEqual({
      hasCharges: false,
    });
  });

  test('a hand-set date bound the plan’s crosses goes; one it does not cross stays and narrows it', () => {
    // A hand-set end before the question's start would make a reversed pair
    // the registry swaps into a range nobody asked for.
    expect(
      applyOverlay(
        { incorporatedTo: '2010-12-31', rating: 'A' },
        { incorporatedFrom: '2020-01-01' },
      ),
    ).toEqual({ rating: 'A', incorporatedFrom: '2020-01-01' });
    expect(
      applyOverlay(
        { incorporatedFrom: '2020-01-01' },
        { incorporatedTo: '2010-12-31' },
      ),
    ).toEqual({ incorporatedTo: '2010-12-31' });
    // "since 2015" over a hand-set "up to 2026" is still a range: both stay.
    expect(
      applyOverlay(
        { incorporatedTo: '2026-12-31' },
        { incorporatedFrom: '2015-01-01' },
      ),
    ).toEqual({ incorporatedTo: '2026-12-31', incorporatedFrom: '2015-01-01' });
    expect(
      applyOverlay(
        { incorporatedFrom: '2015-01-01' },
        { incorporatedTo: '2020-12-31' },
      ),
    ).toEqual({ incorporatedFrom: '2015-01-01', incorporatedTo: '2020-12-31' });
    // Equal edges are one day, not a crossing.
    expect(
      applyOverlay(
        { incorporatedTo: '2020-01-01' },
        { incorporatedFrom: '2020-01-01' },
      ),
    ).toEqual({ incorporatedTo: '2020-01-01', incorporatedFrom: '2020-01-01' });
    // A plan setting both replaces both.
    expect(
      applyOverlay(
        { incorporatedFrom: '2015-01-01', incorporatedTo: '2018-12-31' },
        { incorporatedFrom: '2020-01-01', incorporatedTo: '2021-12-31' },
      ),
    ).toEqual({ incorporatedFrom: '2020-01-01', incorporatedTo: '2021-12-31' });
    expect(
      applyOverlay({ incorporatedFrom: '2015-01-01' }, { location: 'Leeds' }),
    ).toEqual({ incorporatedFrom: '2015-01-01', location: 'Leeds' });
  });
});

describe('describeFilters', () => {
  test('names each filter in plain words, in registry order', () => {
    expect(
      describeFilters({
        route: 'Skilled Worker,Creative Worker',
        rating: 'A-Premium',
        location: 'Sheffield,Bradford',
        sicSection: 'Q',
        companyType: 'llp',
        incorporatedFrom: '2016-01-01',
        hasInsolvencyHistory: false,
        sort: 'incorporated',
        order: 'desc',
      }),
    ).toEqual([
      'Skilled Worker',
      'Creative Worker',
      'Rating A-Premium',
      'In Sheffield or Bradford',
      'Human health and social work activities',
      'LLP',
      'Incorporated from 2016',
      'No insolvency history',
      'Incorporated, newest first',
    ]);
  });

  test('a date chip reads the year at a year edge, the month at a month edge, the day otherwise', () => {
    expect(describeFilters({ incorporatedFrom: '2026-05-01' })).toEqual([
      'Incorporated from May 2026',
    ]);
    expect(describeFilters({ incorporatedTo: '2026-03-31' })).toEqual([
      'Incorporated up to Mar 2026',
    ]);
    expect(describeFilters({ incorporatedFrom: '2024-10-08' })).toEqual([
      'Incorporated from 8 Oct 2024',
    ]);
    expect(describeFilters({ incorporatedTo: '1999-12-31' })).toEqual([
      'Incorporated up to 1999',
    ]);
  });

  test('an unknown slug reads as words; nothing applied is no chips', () => {
    expect(
      describeFilters({
        status: 'voluntary-arrangement',
        companyType: 'uk-establishment',
      }),
    ).toEqual(['Voluntary arrangement', 'UK establishment']);
    expect(describeFilters({})).toEqual([]);
  });
});

describe('describeSector', () => {
  test('the sector reads as ranked first, one chip per section; none is no chips', () => {
    expect(describeSector('K')).toEqual([
      'Financial and insurance activities first',
    ]);
    expect(describeSector('K,J')).toEqual([
      'Financial and insurance activities first',
      'Information and communication first',
    ]);
    expect(describeSector(null)).toEqual([]);
  });
});

describe('applyPlan', () => {
  test('the plan lays over the base, and a sector the plan named replaces a hand-set one by leaving; without one the hand-set sector stays', () => {
    expect(
      applyPlan({ sicSection: 'Q', rating: 'A' }, { location: 'Leeds' }, 'K'),
    ).toEqual({ rating: 'A', location: 'Leeds' });
    expect(applyPlan({ sicSection: 'Q' }, { location: 'Leeds' }, null)).toEqual(
      { sicSection: 'Q', location: 'Leeds' },
    );
    expect(applyPlan({ sicSection: 'Q' }, { sicSection: 'K' }, null)).toEqual({
      sicSection: 'K',
    });
  });
});
