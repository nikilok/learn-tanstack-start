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
  // A row that reaches a move no test asked for is an errored row.
  moveToEstablishment: mock(async () => {
    throw new Error('no move was expected');
  }),
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
    expect(deps.sleep).toHaveBeenCalledWith(2200);
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

describe('sweep — a join on an overseas company whose own establishment is proposed', () => {
  // JPMorgan Chase Bank: the overseas record FC004891, and the one UK establishment the register links to it.
  const SPONSOR = 'JPMorgan Chase Bank, National Association';
  const onOverseas = (over: Partial<ExistingMapping> = {}) =>
    row({
      organisationName: SPONSOR,
      companyNumber: 'FC004891',
      matchMethod: 'exact',
      matchScore: '1.000',
      ...over,
    });
  const establishment = (parent = 'FC004891'): CHFullProfile => ({
    company_number: 'BR000746',
    company_name: 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION',
    company_status: 'open',
    type: 'uk-establishment',
    registered_office_address: { locality: 'London' },
    branch_company_details: { parent_company_number: parent },
  });
  const proposedEstablishment = (
    over: Partial<ProposedResolution> = {},
  ): ProposedResolution =>
    verifiedExact({
      companyNumber: 'BR000746',
      queryUsed: 'JPMorgan Chase Bank National Association',
      profile: establishment(),
      overseas: {
        companyNumber: 'FC004891',
        link: 'followed',
        establishments: ['BR000746'],
      },
      ...over,
    });
  const moved = { kind: 'moved' as const, written: null };
  const JPM_MOVE = {
    companyNumber: 'FC004891',
    establishmentNumber: 'BR000746',
  };

  test('JPMorgan Chase Bank: the whole company moves, and the row is then a join on its establishment', async () => {
    const r = onOverseas();
    const proposed = proposedEstablishment();
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      lookupSponsor: mock(async () => ({
        townCity: 'London',
        county: null,
        route: 'Skilled Worker',
      })),
      resolveSponsor: mock(async () => proposed),
      moveToEstablishment: mock(async () => moved),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).toHaveBeenCalledTimes(1);
    expect(deps.moveToEstablishment).toHaveBeenCalledWith(
      JPM_MOVE,
      SPONSOR,
      'phase5_sweep_exact_establishment',
    );
    // Never the join alone, and never the tie-break: its website and answers would be left behind.
    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(deps.getProfile).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).toHaveBeenCalledWith({
      ...r,
      companyNumber: 'BR000746',
    });
    expect(summary).toMatchObject({
      selected: 1,
      establishmentMoved: 1,
      bumped: 1,
      updated: 0,
      inlineResolved: 0,
      inlineInconclusive: 0,
      establishmentHeld: 0,
      lockMissed: 0,
      errored: 0,
    });
  });

  // Both record types fail the route check, so the tie-break scores them alike and could never decide.
  test('a charity-route sponsor moves all the same', async () => {
    const deps = makeDeps({
      selectRows: mock(async () => [onOverseas()]),
      lookupSponsor: mock(async () => ({
        townCity: null,
        county: null,
        route: 'Charity Worker',
      })),
      resolveSponsor: mock(async () => proposedEstablishment()),
      moveToEstablishment: mock(async () => moved),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(summary).toMatchObject({ establishmentMoved: 1, bumped: 1 });
    expect(deps.getProfile).not.toHaveBeenCalled();
  });

  test('a stronger name match found with the move is one promotion on the establishment', async () => {
    const r = onOverseas({ matchMethod: 'token_sim', matchScore: '0.857' });
    const proposed = proposedEstablishment();
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () => proposed),
      moveToEstablishment: mock(async () => moved),
    });

    const summary = await sweep({ tier: 'non_exact', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).toHaveBeenCalledWith(
      JPM_MOVE,
      SPONSOR,
      'phase5_sweep_non_exact_establishment',
    );
    expect(deps.applyPromotion).toHaveBeenCalledTimes(1);
    expect(deps.applyPromotion).toHaveBeenCalledWith(
      { ...r, companyNumber: 'BR000746' },
      proposed,
      'phase5_sweep_non_exact',
    );
    expect(summary).toMatchObject({ establishmentMoved: 1, updated: 1 });
  });

  test('a weaker name match moves the company too, and leaves the method it had', async () => {
    const r = onOverseas();
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () =>
        proposedEstablishment({
          matchMethod: 'previous_name',
          matchScore: 0.95,
        }),
      ),
      moveToEstablishment: mock(async () => moved),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ establishmentMoved: 1, bumped: 1 });
  });

  test.each([
    ['site_bound'],
    ['manual'],
    ['site_conflict'],
    ['not_establishment'],
  ] as const)(
    'a company held by %s stays whole where it is: the row is bumped and counted, never promoted',
    async (reason) => {
      const r = onOverseas();
      const deps = makeDeps({
        selectRows: mock(async () => [r]),
        resolveSponsor: mock(async () => proposedEstablishment()),
        moveToEstablishment: mock(async () => ({
          kind: 'held' as const,
          reason,
        })),
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(deps.applyPromotion).not.toHaveBeenCalled();
      expect(deps.getProfile).not.toHaveBeenCalled();
      expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(1);
      expect(deps.bumpVerifiedAt).toHaveBeenCalledWith(r);
      expect(summary).toMatchObject({
        establishmentHeld: 1,
        establishmentHeldBy: { [reason]: 1 },
        establishmentMoved: 0,
        bumped: 0,
        updated: 0,
      });
    },
  );

  test('a held row whose bump misses its lock is a lock miss, not a held row', async () => {
    const deps = makeDeps({
      selectRows: mock(async () => [onOverseas()]),
      resolveSponsor: mock(async () => proposedEstablishment()),
      moveToEstablishment: mock(async () => ({
        kind: 'held' as const,
        reason: 'site_bound' as const,
      })),
      bumpVerifiedAt: mock(
        async (): Promise<ApplyResult> => ({
          ok: false,
          reason: 'lock_missed',
        }),
      ),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(summary).toMatchObject({
      lockMissed: 1,
      establishmentHeld: 0,
      establishmentHeldBy: {},
    });
  });

  test('rows changed under the move write nothing more: a lock miss', async () => {
    const deps = makeDeps({
      selectRows: mock(async () => [onOverseas()]),
      resolveSponsor: mock(async () => proposedEstablishment()),
      moveToEstablishment: mock(async () => ({ kind: 'changed' as const })),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ lockMissed: 1, establishmentMoved: 0 });
  });

  test('a move that fails is an errored row, and nothing else is written for it', async () => {
    const originalError = console.error;
    console.error = mock(() => undefined);
    try {
      const deps = makeDeps({
        selectRows: mock(async () => [onOverseas()]),
        resolveSponsor: mock(async () => proposedEstablishment()),
        moveToEstablishment: mock(async () => {
          throw new Error('companies_house: HTTP 502');
        }),
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(deps.applyPromotion).not.toHaveBeenCalled();
      expect(deps.bumpVerifiedAt).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ errored: 1, establishmentMoved: 0 });
    } finally {
      console.error = originalError;
    }
  });

  test("an owner's join is never moved: it warns and bumps as any manual conflict", async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      const r = onOverseas({ matchMethod: 'manual', matchScore: null });
      const deps = makeDeps({
        selectRows: mock(async () => [r]),
        resolveSponsor: mock(async () => proposedEstablishment()),
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(deps.moveToEstablishment).not.toHaveBeenCalled();
      expect(deps.applyPromotion).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ warned: 1, establishmentMoved: 0 });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("another company's establishment is not this company's: the tie-break decides as before", async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      const deps = makeDeps({
        selectRows: mock(async () => [onOverseas()]),
        resolveSponsor: mock(async () =>
          proposedEstablishment({
            profile: establishment('FC000002'),
            overseas: {
              companyNumber: 'FC000002',
              link: 'followed',
              establishments: ['BR000746'],
            },
          }),
        ),
        getProfile: mock(async () => fcProfile({ company_number: 'FC004891' })),
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(deps.moveToEstablishment).not.toHaveBeenCalled();
      expect(deps.getProfile).toHaveBeenCalledWith('FC004891');
      expect(summary.inlineResolved + summary.inlineInconclusive).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('an unmapped sponsor lands on the establishment directly, with nothing to move', async () => {
    const r = row({ organisationName: SPONSOR, matchMethod: 'no_match' });
    const proposed = proposedEstablishment();
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () => proposed),
    });

    const summary = await sweep({ tier: 'no_match', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).not.toHaveBeenCalled();
    expect(deps.applyPromotion).toHaveBeenCalledWith(
      r,
      proposed,
      'phase5_sweep_no_match',
    );
    expect(summary).toMatchObject({ updated: 1, establishmentMoved: 0 });
  });

  test('a join already on the establishment is bumped', async () => {
    const r = onOverseas({ companyNumber: 'BR000746' });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () => proposedEstablishment()),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).toHaveBeenCalledWith(r);
    expect(summary).toMatchObject({ bumped: 1, establishmentMoved: 0 });
  });

  // Caixa Geral de Depositos (FC023485) has open establishments in London and Manchester.
  test('several open establishments leave the join on the overseas record, counted', async () => {
    const r = row({
      organisationName: 'Caixa Geral de Depositos, S.A.',
      companyNumber: 'FC023485',
      matchMethod: 'exact',
    });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () =>
        verifiedExact({
          companyNumber: 'FC023485',
          profile: fcProfile({ company_number: 'FC023485' }),
          overseas: {
            companyNumber: 'FC023485',
            link: 'several',
            establishments: ['BR006261', 'BR028851'],
          },
        }),
      ),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).toHaveBeenCalledWith(r);
    expect(summary).toMatchObject({ bumped: 1, severalEstablishments: 1 });
  });

  // A join on an establishment since closed, where the company's one open establishment is in the sponsor's town: the tie-break would promote, and take the join from its website row.
  test('a join on another establishment of the same company is held, never promoted or sent to the tie-break', async () => {
    const r = onOverseas({ companyNumber: 'BR000001' });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      lookupSponsor: mock(async () => ({
        townCity: 'London',
        county: null,
        route: 'Skilled Worker',
      })),
      resolveSponsor: mock(async () =>
        proposedEstablishment({
          overseas: {
            companyNumber: 'FC004891',
            link: 'followed',
            establishments: ['BR000001', 'BR000746'],
          },
        }),
      ),
      getProfile: mock(async () =>
        ukProfile({
          company_number: 'BR000001',
          company_status: 'closed',
          registered_office_address: { locality: 'Leeds' },
        }),
      ),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).not.toHaveBeenCalled();
    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(deps.getProfile).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).toHaveBeenCalledWith(r);
    expect(summary).toMatchObject({
      establishmentHeld: 1,
      establishmentHeldBy: { other_record: 1 },
      inlineResolved: 0,
      updated: 0,
    });
  });

  test('a stronger name match does not take a join from one establishment to another alone either', async () => {
    const r = onOverseas({
      companyNumber: 'BR000001',
      matchMethod: 'token_sim',
      matchScore: '0.857',
    });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () =>
        proposedEstablishment({
          overseas: {
            companyNumber: 'FC004891',
            link: 'followed',
            establishments: ['BR000001', 'BR000746'],
          },
        }),
      ),
    });

    const summary = await sweep({ tier: 'non_exact', maxRows: 10 }, deps);

    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      establishmentHeld: 1,
      establishmentHeldBy: { other_record: 1 },
      updated: 0,
    });
  });

  // Caixa Geral de Depositos: a join on its London office, where the name matches the overseas record and two are open.
  test('a join on an establishment is not taken back to its overseas company alone', async () => {
    const r = row({
      organisationName: 'Caixa Geral de Depositos, S.A.',
      companyNumber: 'BR006261',
      matchMethod: 'exact',
    });
    const deps = makeDeps({
      selectRows: mock(async () => [r]),
      resolveSponsor: mock(async () =>
        verifiedExact({
          companyNumber: 'FC023485',
          profile: fcProfile({ company_number: 'FC023485' }),
          overseas: {
            companyNumber: 'FC023485',
            link: 'several',
            establishments: ['BR006261', 'BR028851'],
          },
        }),
      ),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(deps.getProfile).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).toHaveBeenCalledWith(r);
    expect(summary).toMatchObject({
      establishmentHeld: 1,
      establishmentHeldBy: { other_record: 1 },
      severalEstablishments: 1,
    });
  });

  test("an owner's join on another record of the company is not held as one: it warns as any manual conflict", async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      const r = onOverseas({
        companyNumber: 'BR000001',
        matchMethod: 'manual',
        matchScore: null,
      });
      const deps = makeDeps({
        selectRows: mock(async () => [r]),
        resolveSponsor: mock(async () =>
          proposedEstablishment({
            overseas: {
              companyNumber: 'FC004891',
              link: 'followed',
              establishments: ['BR000001', 'BR000746'],
            },
          }),
        ),
      });

      const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

      expect(summary).toMatchObject({ warned: 1, establishmentHeld: 0 });
    } finally {
      console.warn = originalWarn;
    }
  });

  // GCH Hotels Windsor's overseas record held two sponsors' joins: one move carries both.
  test('a second join of a company moved earlier in the run is not moved again: it is bumped as a join on the establishment', async () => {
    const first = onOverseas();
    const second = onOverseas({ organisationName: 'JPMorgan Chase Bank NA' });
    const deps = makeDeps({
      selectRows: mock(async () => [first, second]),
      resolveSponsor: mock(async () => proposedEstablishment()),
      moveToEstablishment: mock(async () => moved),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).toHaveBeenCalledTimes(1);
    expect(deps.bumpVerifiedAt).toHaveBeenCalledTimes(2);
    expect(deps.bumpVerifiedAt).toHaveBeenLastCalledWith({
      ...second,
      companyNumber: 'BR000746',
    });
    // One company moved, however many of its joins the run reads: a dry run counts the same.
    expect(summary).toMatchObject({
      establishmentMoved: 1,
      bumped: 2,
      lockMissed: 0,
    });
  });

  test('a company held is asked again for its next join, and each row is counted', async () => {
    const first = onOverseas();
    const second = onOverseas({
      organisationName: 'J.P. Morgan Chase Bank NA',
    });
    const deps = makeDeps({
      selectRows: mock(async () => [first, second]),
      resolveSponsor: mock(async () => proposedEstablishment()),
      moveToEstablishment: mock(async () => ({
        kind: 'held' as const,
        reason: 'site_bound' as const,
      })),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.moveToEstablishment).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      establishmentMoved: 0,
      establishmentHeld: 2,
      establishmentHeldBy: { site_bound: 2 },
    });
  });

  /** A second sponsor on JPMorgan's overseas record whose own name resolves to another company. */
  const laterJoin = (over: Partial<ExistingMapping> = {}) =>
    onOverseas({ organisationName: 'JPMorgan Chase Bank NA', ...over });
  const anotherCompany = verifiedExact({
    companyNumber: '01234567',
    profile: {
      company_number: '01234567',
      company_name: 'JPMORGAN CHASE BANK NA LIMITED',
      company_status: 'active',
      type: 'ltd',
      registered_office_address: { locality: 'Leeds' },
    },
  });
  /** The first sponsor's name resolves to the establishment, the second's to another company. */
  const resolveEachTheirOwn = mock(async (name: string) =>
    name === SPONSOR ? proposedEstablishment() : anotherCompany,
  );

  test('a later join of a company moved in the run is read where it now is: the tie-break scores the establishment', async () => {
    const second = laterJoin();
    const deps = makeDeps({
      selectRows: mock(async () => [onOverseas(), second]),
      lookupSponsor: mock(async () => ({
        townCity: 'London',
        county: null,
        route: 'Skilled Worker',
      })),
      resolveSponsor: resolveEachTheirOwn,
      moveToEstablishment: mock(async () => moved),
      getProfile: mock(async (number: string) =>
        number === 'BR000746'
          ? establishment()
          : fcProfile({ company_number: number }),
      ),
    });

    const summary = await sweep({ tier: 'exact', maxRows: 10 }, deps);

    // Read off the overseas record, in Wilmington, the same pair is left undecided; on the establishment in the sponsor's town the join is kept.
    expect(deps.getProfile).toHaveBeenCalledTimes(1);
    expect(deps.getProfile).toHaveBeenCalledWith('BR000746');
    expect(deps.applyPromotion).not.toHaveBeenCalled();
    expect(deps.bumpVerifiedAt).toHaveBeenLastCalledWith({
      ...second,
      companyNumber: 'BR000746',
    });
    expect(summary).toMatchObject({
      establishmentMoved: 1,
      inlineResolved: 1,
      inlineInconclusive: 0,
    });
  });

  test('a later join promoted to another company is recorded as leaving the establishment', async () => {
    const second = laterJoin({ matchMethod: 'token_sim', matchScore: '0.857' });
    const deps = makeDeps({
      selectRows: mock(async () => [onOverseas(), second]),
      resolveSponsor: resolveEachTheirOwn,
      moveToEstablishment: mock(async () => moved),
    });

    await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.applyPromotion).toHaveBeenCalledTimes(1);
    expect(deps.applyPromotion).toHaveBeenCalledWith(
      { ...second, companyNumber: 'BR000746' },
      anotherCompany,
      'phase5_sweep_exact',
    );
  });

  test('a later join of a company that was held, not moved, is read where it was', async () => {
    const second = laterJoin();
    const deps = makeDeps({
      selectRows: mock(async () => [onOverseas(), second]),
      resolveSponsor: resolveEachTheirOwn,
      moveToEstablishment: mock(async () => ({
        kind: 'held' as const,
        reason: 'site_bound' as const,
      })),
      getProfile: mock(async (number: string) =>
        fcProfile({ company_number: number }),
      ),
    });

    await sweep({ tier: 'exact', maxRows: 10 }, deps);

    expect(deps.getProfile).toHaveBeenCalledWith('FC004891');
  });
});
