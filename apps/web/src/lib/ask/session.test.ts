import { describe, expect, test } from 'bun:test';

import type { AppliedAsk } from './applied-store';
import { paramsKey } from './overlay';
import {
  askBoxMode,
  askEntry,
  askEntryState,
  listedRanking,
  deriveAskHint,
  nextEmptyPrefix,
  droppedRanking,
  reconcileApplied,
  restoresBare,
  runRetired,
} from './session';

const merged = { location: 'Leeds', sicSection: 'Q' };
const plan: AppliedAsk = {
  text: 'care homes in leeds',
  base: {},
  mergedKey: paramsKey(merged),
  chips: ['In Leeds', 'Human health and social work'],
  ranking: null,
};
const planKey = paramsKey(merged);
const otherKey = paramsKey({ rating: 'A' });
const bareKey = paramsKey({});

describe('askEntry', () => {
  test("reads the plan from an entry the ask produced, as the router's state carries it", () => {
    expect(askEntry(askEntryState(plan))).toEqual(plan);
    expect(
      askEntry({ ...askEntryState(plan), __TSR_index: 3, key: 'k' }),
    ).toEqual(plan);
    // Across a reload the state comes back structured-cloned, not the same object.
    expect(askEntry(JSON.parse(JSON.stringify(askEntryState(plan))))).toEqual(
      plan,
    );
  });

  test('any other entry carries no plan', () => {
    expect(askEntry({ __TSR_index: 3 })).toBeNull();
    expect(askEntry({ ask: true })).toBeNull();
    expect(askEntry({ ask: { text: 'x' } })).toBeNull();
    expect(askEntry(null)).toBeNull();
    expect(askEntry(undefined)).toBeNull();
  });
});

describe('reconcileApplied', () => {
  const landed = {
    applied: null,
    hasFilters: true,
    urlKey: planKey,
    entry: plan,
    record: plan,
  };

  test('a live plan is kept while the URL carries its filters', () => {
    expect(
      reconcileApplied({
        applied: plan,
        hasFilters: true,
        urlKey: planKey,
        entry: plan,
        record: plan,
      }),
    ).toBe('keep');
  });

  test('a live plan is its own entry’s: any other entry ends it, whatever the URL’s key', () => {
    // Back onto the typed text, the header logo, a Reset: a bare entry.
    const pure = {
      ...plan,
      base: {},
      mergedKey: bareKey,
      chips: [],
      ranking: {
        span: 'care homes',
        sector: null,
        tranches: [['00000001']],
        next: null,
      },
    };
    expect(
      reconcileApplied({
        applied: pure,
        hasFilters: false,
        urlKey: bareKey,
        entry: null,
        record: pure,
      }),
    ).toBe('end');
    // Another question's own entry under the same filters.
    expect(
      reconcileApplied({
        applied: plan,
        hasFilters: true,
        urlKey: planKey,
        entry: { ...plan, text: 'nursing homes in leeds' },
        record: plan,
      }),
    ).toBe('end');
    // Its own entry with the ranking dropped by the about chip: the same question.
    expect(
      reconcileApplied({
        applied: { ...plan, ranking: null },
        hasFilters: true,
        urlKey: planKey,
        entry: plan,
        record: plan,
      }),
    ).toBe('keep');
  });

  test('the URL moving to another set, or to none, ends the plan', () => {
    expect(
      reconcileApplied({
        applied: plan,
        hasFilters: true,
        urlKey: otherKey,
        entry: null,
        record: plan,
      }),
    ).toBe('end');
    // Back to the question, the listing's own Reset, the header logo: bare.
    expect(
      reconcileApplied({
        applied: plan,
        hasFilters: false,
        urlKey: bareKey,
        entry: null,
        record: plan,
      }),
    ).toBe('end');
  });

  test('an entry the ask produced restores the plan it carries once the URL holds its filters', () => {
    // The landing, Forward or Back onto it, a reload: with or without a record.
    expect(reconcileApplied(landed)).toBe('restore');
    expect(reconcileApplied({ ...landed, record: null })).toBe('restore');
    // The router commits the location before the match: not yet.
    expect(reconcileApplied({ ...landed, urlKey: otherKey })).toBe('keep');
    expect(
      reconcileApplied({ ...landed, hasFilters: false, urlKey: bareKey }),
    ).toBe('keep');
  });

  test('a hand-set set is never a restore, and a record it meets there is stale', () => {
    // The same filters set on /filters while this page was away: the entry
    // carries nothing, so the record a plan left behind goes.
    expect(reconcileApplied({ ...landed, entry: null })).toBe('discard');
    expect(reconcileApplied({ ...landed, entry: null, urlKey: otherKey })).toBe(
      'discard',
    );
    expect(reconcileApplied({ ...landed, entry: null, record: null })).toBe(
      'keep',
    );
  });

  test('a bare URL restores the entry of a question that applied no filters, only a ranking', () => {
    const pure = {
      ...plan,
      base: {},
      mergedKey: bareKey,
      chips: [],
      ranking: {
        span: 'care homes',
        sector: null,
        tranches: [['00000001']],
        next: null,
      },
    };
    expect(
      reconcileApplied({
        applied: null,
        hasFilters: false,
        urlKey: bareKey,
        entry: pure,
        record: null,
      }),
    ).toBe('restore');
    // On its way: an entry whose filters the URL does not hold yet.
    expect(
      reconcileApplied({
        applied: null,
        hasFilters: true,
        urlKey: otherKey,
        entry: pure,
        record: null,
      }),
    ).toBe('keep');
  });

  test('a bare URL leaves the record alone for the store to re-apply', () => {
    // A company page's back link: the rehydrate carries the record next.
    expect(
      reconcileApplied({
        applied: null,
        hasFilters: false,
        urlKey: bareKey,
        entry: null,
        record: plan,
      }),
    ).toBe('keep');
  });
});

describe('deriveAskHint', () => {
  const base = {
    applied: false,
    access: 'open' as const,
    progress: { status: 'idle' } as const,
    couldAsk: true,
    keyboard: true,
  };

  test('offers only while open, unapplied and askable', () => {
    expect(deriveAskHint(base)).toEqual({
      eligible: true,
      hint: { status: 'eligible', keyboard: true },
    });
    expect(deriveAskHint({ ...base, couldAsk: false })).toEqual({
      eligible: false,
      hint: null,
    });
    expect(deriveAskHint({ ...base, access: 'off' }).hint).toBeNull();
    expect(deriveAskHint({ ...base, applied: true })).toEqual({
      eligible: false,
      hint: null,
    });
  });

  test('a running ask is neither offered again nor explained', () => {
    expect(deriveAskHint({ ...base, progress: { status: 'pending' } })).toEqual(
      {
        eligible: false,
        hint: { status: 'pending', keyboard: true },
      },
    );
  });

  test('an empty or failed answer is explained before the text is offered again, and carries its reason', () => {
    expect(
      deriveAskHint({
        ...base,
        progress: { status: 'empty', reason: 'name' },
      }),
    ).toEqual({
      eligible: true,
      hint: { status: 'empty', reason: 'name', keyboard: true },
    });
    expect(
      deriveAskHint({ ...base, progress: { status: 'unavailable' } }),
    ).toEqual({
      eligible: true,
      hint: { status: 'unavailable', keyboard: true },
    });
  });

  test('a touch device has no key to name', () => {
    expect(deriveAskHint({ ...base, keyboard: false }).hint).toEqual({
      status: 'eligible',
      keyboard: false,
    });
  });
});

describe('nextEmptyPrefix', () => {
  test('the offer sets the prefix and keeps it at its shortest', () => {
    expect(
      nextEmptyPrefix(null, {
        eligible: true,
        loading: false,
        search: 'list of nhs',
      }),
    ).toBe('list of nhs');
    expect(
      nextEmptyPrefix('list of nhs', {
        eligible: true,
        loading: false,
        search: 'list of nhs lothian',
      }),
    ).toBe('list of nhs');
    expect(
      nextEmptyPrefix('list of nhs', {
        eligible: true,
        loading: false,
        search: 'care homes in leeds',
      }),
    ).toBe('care homes in leeds');
  });

  test('a load (or a running ask) leaves the prefix; anything else that settles without the offer forgets it', () => {
    expect(
      nextEmptyPrefix('list of nhs', {
        eligible: false,
        loading: true,
        search: 'list of nhs lothian',
      }),
    ).toBe('list of nhs');
    expect(
      nextEmptyPrefix('list of nhs', {
        eligible: false,
        loading: false,
        search: 'list of nhs lothian',
      }),
    ).toBeNull();
    expect(
      nextEmptyPrefix('list of nhs', {
        eligible: false,
        loading: false,
        search: '',
      }),
    ).toBeNull();
  });
});

describe('listedRanking', () => {
  const ranking = {
    span: 'care homes',
    sector: null,
    tranches: [['00000001']],
    next: null,
  };
  const live = { ...plan, ranking };

  test('the applied plan’s ranking while the URL holds its filters, else the entry’s for the URL, else nothing', () => {
    expect(
      listedRanking({
        applied: live,
        entry: null,
        urlKey: planKey,
        hydrated: true,
      }),
    ).toBe(ranking);
    expect(
      listedRanking({
        applied: live,
        entry: live,
        urlKey: otherKey,
        hydrated: true,
      }),
    ).toBeNull();
    const onto = {
      ...live,
      mergedKey: otherKey,
      ranking: { ...ranking, span: 'law firms' },
    };
    expect(
      listedRanking({
        applied: live,
        entry: onto,
        urlKey: otherKey,
        hydrated: true,
      }),
    ).toBe(onto.ranking);
  });

  test('before the plan is applied, the entry’s ranking once the URL holds its filters', () => {
    expect(
      listedRanking({
        applied: null,
        entry: live,
        urlKey: planKey,
        hydrated: true,
      }),
    ).toBe(ranking);
    expect(
      listedRanking({
        applied: null,
        entry: live,
        urlKey: otherKey,
        hydrated: true,
      }),
    ).toBeNull();
    expect(
      listedRanking({
        applied: null,
        entry: null,
        urlKey: planKey,
        hydrated: true,
      }),
    ).toBeNull();
  });

  test("another question's own entry under the same key outranks the applied plan's ranking: the reconcile ends that plan next", () => {
    const other = {
      ...live,
      text: 'nursing homes in leeds',
      ranking: { ...ranking, span: 'nursing homes' },
    };
    expect(
      listedRanking({
        applied: live,
        entry: other,
        urlKey: planKey,
        hydrated: true,
      }),
    ).toBe(other.ranking);
    expect(
      listedRanking({
        applied: live,
        entry: { ...other, ranking: null },
        urlKey: planKey,
        hydrated: true,
      }),
    ).toBeNull();
  });

  test('nothing on the hydration render, whatever the entry carries', () => {
    expect(
      listedRanking({
        applied: null,
        entry: live,
        urlKey: planKey,
        hydrated: false,
      }),
    ).toBeNull();
  });
});

describe('askBoxMode', () => {
  test('on while a plan is applied, pending while a question runs, else off', () => {
    expect(askBoxMode({ applied: true, progress: { status: 'idle' } })).toBe(
      'on',
    );
    expect(askBoxMode({ applied: true, progress: { status: 'pending' } })).toBe(
      'on',
    );
    expect(
      askBoxMode({ applied: false, progress: { status: 'pending' } }),
    ).toBe('pending');
    expect(askBoxMode({ applied: false, progress: { status: 'idle' } })).toBe(
      'off',
    );
    expect(
      askBoxMode({ applied: false, progress: { status: 'unavailable' } }),
    ).toBe('off');
    expect(
      askBoxMode({
        applied: false,
        progress: { status: 'empty', reason: 'name' },
      }),
    ).toBe('off');
  });

  test('a further slice being judged turns the ring on an applied plan, and means nothing without one', () => {
    expect(
      askBoxMode({
        applied: true,
        progress: { status: 'idle' },
        judging: true,
      }),
    ).toBe('pending');
    expect(
      askBoxMode({
        applied: false,
        progress: { status: 'idle' },
        judging: true,
      }),
    ).toBe('off');
  });
});

describe('runRetired', () => {
  const run = { text: 'care homes in leeds', urlKey: planKey };

  test('a run stands while the URL holds its text and the filters it was asked under', () => {
    expect(
      runRetired({ search: 'care homes in leeds', urlKey: planKey }, run),
    ).toBe(false);
  });

  test('the text moving off the one asked retires it, as the plan landing does', () => {
    expect(runRetired({ search: 'care homes', urlKey: planKey }, run)).toBe(
      true,
    );
    expect(runRetired({ search: '', urlKey: planKey }, run)).toBe(true);
  });

  test('the filters moving off the set it was asked under retires it: a Back under the run', () => {
    expect(
      runRetired({ search: 'care homes in leeds', urlKey: otherKey }, run),
    ).toBe(true);
    expect(
      runRetired({ search: 'care homes in leeds', urlKey: bareKey }, run),
    ).toBe(true);
  });
});

describe('restoresBare', () => {
  const ranking = {
    span: 'care homes',
    sector: null,
    tranches: [['00000001']],
    next: null,
  };

  test('a record with a ranking under no filters: a bare URL re-applies it', () => {
    expect(
      restoresBare({
        ...plan,
        base: {},
        mergedKey: bareKey,
        chips: [],
        ranking,
      }),
    ).toBe(true);
  });

  test('a record whose filters the URL would carry, one without a ranking, or none at all is not one', () => {
    expect(restoresBare({ ...plan, ranking })).toBe(false);
    expect(
      restoresBare({ ...plan, base: {}, mergedKey: bareKey, chips: [] }),
    ).toBe(false);
    expect(restoresBare(null)).toBe(false);
  });
});

describe('droppedRanking', () => {
  const ranked = {
    ...plan,
    ranking: {
      span: 'care homes',
      sector: 'Q',
      tranches: [['00000001']],
      next: null,
    },
  };

  test('the sector the question named becomes one of its filters, named last among the chips, with no ranking left', () => {
    const dropped = droppedRanking(
      { ...ranked, chips: ['In Leeds'] },
      { location: 'Leeds' },
    );
    expect(dropped?.merged).toEqual({ location: 'Leeds', sicSection: 'Q' });
    expect(dropped?.plan).toEqual({
      ...ranked,
      chips: ['In Leeds', 'Human health and social work activities'],
      mergedKey: paramsKey({ location: 'Leeds', sicSection: 'Q' }),
      ranking: null,
    });
  });

  test("without a sector the filters stand as they are, in the registry's form", () => {
    const dropped = droppedRanking(
      { ...ranked, ranking: { ...ranked.ranking, sector: null } },
      { sicSection: 'Q', location: 'Leeds' },
    );
    expect(dropped?.merged).toEqual({ location: 'Leeds', sicSection: 'Q' });
    expect(dropped?.plan.chips).toEqual(plan.chips);
    expect(dropped?.plan.ranking).toBeNull();
  });

  test('a question that only ranked, naming no sector, has nothing left to list', () => {
    expect(
      droppedRanking(
        { ...ranked, chips: [], ranking: { ...ranked.ranking, sector: null } },
        {},
      ),
    ).toBeNull();
  });
});
