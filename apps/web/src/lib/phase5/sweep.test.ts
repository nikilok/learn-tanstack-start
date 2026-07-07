import { describe, expect, mock, test } from 'bun:test';

import type {
  CHFullProfile,
  ExistingMapping,
  ProposedResolution,
} from './decide.ts';
import type { ApplyResult, SweepDeps, SweepSponsor } from './sweep.ts';
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

const noSponsor: SweepSponsor = { townCity: null, county: null, route: null };

const ukProfile = (over: Partial<CHFullProfile> = {}): CHFullProfile => ({
  company_number: 'BR000001',
  company_name: 'ACME LTD',
  company_status: 'open',
  type: 'uk-establishment',
  registered_office_address: { locality: 'London' },
  ...over,
});

const fcProfile = (over: Partial<CHFullProfile> = {}): CHFullProfile => ({
  company_number: 'FC000001',
  company_name: 'ACME LTD',
  company_status: 'active',
  type: 'oversea-company',
  registered_office_address: { locality: 'Wilmington' },
  ...over,
});

const makeDeps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
  selectRows: mock(async () => []),
  lookupSponsor: mock(async () => noSponsor),
  resolveSponsor: mock(async () => verifiedExact()),
  getProfile: mock(async () => null),
  applyPromotion: mock(async () => ({ ok: true as const })),
  bumpVerifiedAt: mock(async () => ({ ok: true as const })),
  sleep: mock(async () => undefined),
  ...over,
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
    expect(summary).toMatchObject({
      selected: 1,
      updated: 1,
      bumped: 0,
      inlineResolved: 0,
      inlineInconclusive: 0,
      warned: 0,
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
    expect(summary).toMatchObject({
      selected: 1,
      bumped: 1,
      updated: 0,
    });
  });
});

describe('sweep — log_and_bump dispatch', () => {
  test('manual conflict warns AND bumps; warned counter increments', async () => {
    const r = row({ matchMethod: 'manual', companyNumber: '12345678' });
    const warnSpy = mock((_msg: string) => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const deps = makeDeps({
        selectRows: mock(async () => [r]),
        resolveSponsor: mock(async () =>
          verifiedExact({ companyNumber: '99999999' }),
        ),
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toContain('manual_conflict');
      expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
      expect(deps.applyPromotion).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        selected: 1,
        warned: 1,
        bumped: 0,
        updated: 0,
      });
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('sweep — inline_score dispatch', () => {
  test('scorer says promote → applyPromotion, inlineResolved increments', async () => {
    const r = row({
      organisationName: 'ACME LTD',
      matchMethod: 'exact',
      companyNumber: 'FC000001',
    });
    // Sponsor in London → existing FC (Wilmington) has no locality match,
    // proposed BR (London) does + UK-presence boost → promote.
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      lookupSponsor: mock(async () => ({
        townCity: 'London',
        county: null,
        route: 'Skilled Worker',
      })),
      resolveSponsor: mock(async () =>
        verifiedExact({
          companyNumber: 'BR000001',
          profile: ukProfile(),
        }),
      ),
      getProfile: mock(async () => fcProfile()),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.applyPromotion).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      selected: 1,
      inlineResolved: 1,
      updated: 0,
      inlineInconclusive: 0,
    });
  });

  test('scorer says keep → bumpVerifiedAt, inlineResolved increments (not applyPromotion)', async () => {
    const r = row({
      organisationName: 'ACME LTD',
      matchMethod: 'exact',
      companyNumber: 'BR000001',
    });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      lookupSponsor: mock(async () => ({
        townCity: 'London',
        county: null,
        route: 'Skilled Worker',
      })),
      resolveSponsor: mock(async () =>
        verifiedExact({
          companyNumber: 'FC000001',
          profile: fcProfile(),
        }),
      ),
      getProfile: mock(async () => ukProfile()),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      selected: 1,
      inlineResolved: 1,
      inlineInconclusive: 0,
    });
  });

  test('scorer inconclusive → bumpVerifiedAt + warn; inlineInconclusive increments', async () => {
    const r = row({
      organisationName: 'ACME LTD',
      matchMethod: 'exact',
      companyNumber: 'AAAA1111',
    });
    const warnSpy = mock((_msg: string) => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      // Two identical ltd profiles with same locality → effective diff < margin.
      const deps = makeDeps({
        selectRows: mock(async () => [r]),
        lookupSponsor: mock(async () => ({
          townCity: 'Manchester',
          county: null,
          route: 'Skilled Worker',
        })),
        resolveSponsor: mock(async () =>
          verifiedExact({
            companyNumber: 'BBBB2222',
            profile: {
              company_number: 'BBBB2222',
              company_name: 'ACME LTD',
              company_status: 'active',
              type: 'ltd',
              registered_office_address: { locality: 'Manchester' },
            },
          }),
        ),
        getProfile: mock(async () => ({
          company_number: 'AAAA1111',
          company_name: 'ACME LTD',
          company_status: 'active',
          type: 'ltd',
          registered_office_address: { locality: 'Manchester' },
        })),
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(deps.applyPromotion).not.toHaveBeenCalled();
      expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toContain('inconclusive');
      expect(summary).toMatchObject({
        selected: 1,
        inlineInconclusive: 1,
        inlineResolved: 0,
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test('inline_score missing existing profile → bump + warn + inlineInconclusive++', async () => {
    const r = row({
      organisationName: 'ACME LTD',
      matchMethod: 'exact',
      companyNumber: 'BR999999',
    });
    const warnSpy = mock((_msg: string) => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const deps = makeDeps({
        selectRows: mock(async () => [r]),
        lookupSponsor: mock(async () => ({
          townCity: 'London',
          county: null,
          route: 'Skilled Worker',
        })),
        resolveSponsor: mock(async () =>
          verifiedExact({
            companyNumber: 'FC000001',
            profile: fcProfile(),
          }),
        ),
        getProfile: mock(async () => null), // existing not cached
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(deps.applyPromotion).not.toHaveBeenCalled();
      expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('missing profile');
      expect(summary.inlineInconclusive).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('sweep — rate-limit sleep', () => {
  test('default sleep is called between rows but not after the last one', async () => {
    const r1 = row({ organisationName: 'ONE LTD' });
    const r2 = row({ organisationName: 'TWO LTD' });
    const r3 = row({ organisationName: 'THREE LTD' });
    const deps = makeDeps({
      selectRows: mock(async () => [r1, r2, r3]),
      resolveSponsor: mock(async () => verifiedExact()),
    });

    await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(2500);
  });

  test('empty result set: sleep is not called', async () => {
    const deps = makeDeps({
      selectRows: mock(async () => []),
    });

    await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.sleep).not.toHaveBeenCalled();
  });

  test('config.delayMs override is honoured (CLI uses this for PHASE5_DELAY_MS env)', async () => {
    const r1 = row({ organisationName: 'ONE LTD' });
    const r2 = row({ organisationName: 'TWO LTD' });
    const deps = makeDeps({
      selectRows: mock(async () => [r1, r2]),
      resolveSponsor: mock(async () => verifiedExact()),
    });

    await sweep({ tier: 'no_match', maxRows: 10, delayMs: 5000 }, deps);

    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(5000);
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
      applyPromotion: mock(
        async (): Promise<ApplyResult> => ({
          ok: false,
          reason: 'lock_missed',
        }),
      ),
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

  test('bump that hits an optimistic-lock miss increments lockMissed, not bumped', async () => {
    // Regression: the 2026-05-28 freeze was invisible because bumps counted
    // as successes regardless of whether the UPDATE matched any row.
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
      bumpVerifiedAt: mock(
        async (): Promise<ApplyResult> => ({
          ok: false,
          reason: 'lock_missed',
        }),
      ),
    });

    const summary = await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      selected: 1,
      updated: 0,
      bumped: 0,
      lockMissed: 1,
      errored: 0,
    });
  });
});
