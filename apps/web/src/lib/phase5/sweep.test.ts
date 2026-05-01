import { describe, expect, mock, test } from 'bun:test';
import type { ExistingMapping, ProposedResolution } from './decide.ts';
import type { ApplyResult, SweepDeps, SweepLocality } from './sweep.ts';
import { sweep } from './sweep.ts';

const row = (over: Partial<ExistingMapping> = {}): ExistingMapping => ({
  organisationName: 'ACME LTD',
  companyNumber: null,
  matchMethod: 'no_match',
  matchScore: null,
  verifiedAt: new Date('2026-01-01T00:00:00Z'),
  isPublicBody: false,
  ...over,
});

const verifiedExact = (
  over: Partial<ProposedResolution> = {},
): ProposedResolution => ({
  verdict: 'verified',
  companyNumber: '12345678',
  matchMethod: 'exact',
  matchScore: 1,
  queryUsed: 'ACME LTD',
  ...over,
});

const noLocality: SweepLocality = { townCity: null, county: null };

const makeDeps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
  selectRows: mock(async () => []),
  lookupLocality: mock(async () => noLocality),
  resolveSponsor: mock(async () => verifiedExact()),
  applyPromotion: mock(async () => ({ ok: true as const })),
  bumpVerifiedAt: mock(async () => undefined),
  enqueueReview: mock(async () => undefined),
  sleep: mock(async () => undefined),
  ...over,
});

describe('sweep — mixed-decision batch', () => {
  test('one update + one bump + one queue + one lock_miss + one error → summary tallies all five', async () => {
    const rUpdate = row({
      organisationName: 'PROMOTE LTD',
      matchMethod: 'no_match',
    });
    const rBump = row({
      organisationName: 'STAY LTD',
      matchMethod: 'no_match',
    });
    const rQueue = row({
      organisationName: 'CONFLICT LTD',
      matchMethod: 'manual',
      companyNumber: '11111111',
    });
    const rLockMiss = row({
      organisationName: 'RACE LTD',
      matchMethod: 'no_match',
    });
    const rError = row({
      organisationName: 'BREAKS LTD',
      matchMethod: 'no_match',
    });

    const resolveSponsor = mock(async (orgName: string) => {
      if (orgName === 'PROMOTE LTD') return verifiedExact();
      if (orgName === 'STAY LTD') {
        return {
          verdict: 'no_match' as const,
          companyNumber: null,
          matchMethod: 'no_match' as const,
          matchScore: null,
          queryUsed: orgName,
        };
      }
      if (orgName === 'CONFLICT LTD') {
        return verifiedExact({ companyNumber: '99999999' });
      }
      if (orgName === 'RACE LTD') return verifiedExact();
      throw new Error('CH 500');
    });

    const applyPromotion = mock(
      async (existing: ExistingMapping): Promise<ApplyResult> => {
        if (existing.organisationName === 'RACE LTD') {
          return { ok: false, reason: 'lock_missed' };
        }
        return { ok: true };
      },
    );

    const deps = makeDeps({
      selectRows: mock(async () => [rUpdate, rBump, rQueue, rLockMiss, rError]),
      resolveSponsor,
      applyPromotion,
    });

    const summary = await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(summary).toEqual({
      selected: 5,
      updated: 1,
      bumped: 1,
      queued: 1,
      lockMissed: 1,
      errored: 1,
    });
  });
});

describe('sweep — rate-limit sleep', () => {
  test('sleep(2200) is called between rows but not after the last one', async () => {
    const r1 = row({ organisationName: 'ONE LTD' });
    const r2 = row({ organisationName: 'TWO LTD' });
    const r3 = row({ organisationName: 'THREE LTD' });
    const deps = makeDeps({
      selectRows: mock(async () => [r1, r2, r3]),
      resolveSponsor: mock(async () => verifiedExact()),
    });

    await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    // 3 rows → 2 sleeps (between row 1↔2 and row 2↔3)
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(2200);
  });

  test('empty result set: sleep is not called', async () => {
    const deps = makeDeps({
      selectRows: mock(async () => []),
    });

    await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.sleep).not.toHaveBeenCalled();
  });
});

describe('sweep — error handling', () => {
  test('resolveSponsor throw on row 1 is counted as errored; row 2 still processes', async () => {
    const r1 = row({ organisationName: 'BREAKS LTD', matchMethod: 'no_match' });
    const r2 = row({ organisationName: 'WORKS LTD', matchMethod: 'no_match' });

    const resolveSponsor = mock(async (orgName: string) => {
      if (orgName === 'BREAKS LTD') throw new Error('CH 500');
      return verifiedExact();
    });

    const deps = makeDeps({
      selectRows: mock(async () => [r1, r2]),
      resolveSponsor,
    });

    const summary = await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(resolveSponsor).toHaveBeenCalledTimes(2);
    expect(deps.applyPromotion).toHaveBeenCalledTimes(1);
    expect(deps.applyPromotion).toHaveBeenCalledWith(
      r2,
      verifiedExact(),
      'phase5_sweep_no_match',
    );
    expect(summary).toMatchObject({
      selected: 2,
      updated: 1,
      errored: 1,
    });
  });
});

describe('sweep — lock_missed handling', () => {
  test('promotion that hits an optimistic-lock miss increments lockMissed, not updated', async () => {
    const r = row({ matchMethod: 'no_match' });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () => verifiedExact()),
      applyPromotion: mock(async () => ({
        ok: false as const,
        reason: 'lock_missed' as const,
      })),
    });

    const summary = await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.applyPromotion).toHaveBeenCalledTimes(1);
    expect(deps.bumpVerifiedAt).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      selected: 1,
      updated: 0,
      bumped: 0,
      lockMissed: 1,
      errored: 0,
    });
  });
});

describe('sweep — queue dispatch', () => {
  test('manual conflict calls enqueueReview AND bumpVerifiedAt (in that order)', async () => {
    const r = row({ matchMethod: 'manual', companyNumber: '12345678' });
    const calls: string[] = [];
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () =>
        verifiedExact({ companyNumber: '99999999' }),
      ),
      enqueueReview: mock(async () => {
        calls.push('enqueueReview');
      }),
      bumpVerifiedAt: mock(async () => {
        calls.push('bumpVerifiedAt');
      }),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.enqueueReview).toHaveBeenCalledTimes(1);
    expect(deps.enqueueReview).toHaveBeenCalledWith(
      r,
      verifiedExact({ companyNumber: '99999999' }),
      'manual_conflict',
      'phase5_sweep_exact',
    );
    expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['enqueueReview', 'bumpVerifiedAt']);
    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      selected: 1,
      updated: 0,
      bumped: 0,
      queued: 1,
      lockMissed: 0,
      errored: 0,
    });
  });
});

describe('sweep — bump dispatch', () => {
  test('no_match → no_match calls bumpVerifiedAt, not applyPromotion', async () => {
    const r = row({ matchMethod: 'no_match' });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () => ({
        verdict: 'no_match' as const,
        companyNumber: null,
        matchMethod: 'no_match' as const,
        matchScore: null,
        queryUsed: 'ACME LTD',
      })),
    });

    const summary = await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
    expect(deps.bumpVerifiedAt).toHaveBeenCalledWith(r);
    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(deps.enqueueReview).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      selected: 1,
      updated: 0,
      bumped: 1,
      queued: 0,
      lockMissed: 0,
      errored: 0,
    });
  });
});

describe('sweep — happy path dispatch', () => {
  test('row that promotes is routed to applyPromotion with the right changedBy', async () => {
    const r = row({ matchMethod: 'no_match' });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () =>
        verifiedExact({ companyNumber: '12345678' }),
      ),
    });

    const summary = await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.applyPromotion).toHaveBeenCalledTimes(1);
    expect(deps.applyPromotion).toHaveBeenCalledWith(
      r,
      verifiedExact({ companyNumber: '12345678' }),
      'phase5_sweep_no_match',
    );
    expect(deps.bumpVerifiedAt).not.toHaveBeenCalled();
    expect(deps.enqueueReview).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      selected: 1,
      updated: 1,
      bumped: 0,
      queued: 0,
      lockMissed: 0,
      errored: 0,
    });
  });
});
