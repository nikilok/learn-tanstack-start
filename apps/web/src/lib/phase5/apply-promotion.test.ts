import { describe, expect, mock, test } from 'bun:test';
import type {
  ApplyPromotionDeps,
  CHFullProfile,
  MappingUpdateResult,
} from './apply-promotion.ts';
import { applyPromotion } from './apply-promotion.ts';
import type { ExistingMapping, ProposedResolution } from './decide.ts';

const existing = (over: Partial<ExistingMapping> = {}): ExistingMapping => ({
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

const updatedRow: MappingUpdateResult = {
  organisationName: 'ACME LTD',
  newCompanyNumber: '12345678',
  newMatchMethod: 'exact',
};

const makeDeps = (
  over: Partial<ApplyPromotionDeps> = {},
): ApplyPromotionDeps => ({
  updateMapping: mock(async () => updatedRow),
  insertAudit: mock(async () => undefined),
  upsertProfile: mock(async () => undefined),
  ...over,
});

describe('applyPromotion — mapping write', () => {
  test('successful update: returns ok with the new state from RETURNING', async () => {
    const e = existing();
    const p = verifiedExact();
    const deps = makeDeps();

    const result = await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.updateMapping).toHaveBeenCalledTimes(1);
    expect(deps.updateMapping).toHaveBeenCalledWith({
      organisationName: 'ACME LTD',
      originalVerifiedAt: e.verifiedAt,
      newCompanyNumber: '12345678',
      newMatchMethod: 'exact',
      newMatchScore: 1,
      newQueryUsed: 'ACME LTD',
      newIsPublicBody: false,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('applyPromotion — profile upsert', () => {
  const profile: CHFullProfile = {
    company_number: '12345678',
    company_name: 'ACME LTD',
    company_status: 'active',
  };

  test('verified verdict with profile: upsertProfile is called AFTER updateMapping + insertAudit', async () => {
    const calls: string[] = [];
    const e = existing({ matchMethod: 'no_match', companyNumber: null });
    const p = verifiedExact({ profile });
    const deps = makeDeps({
      updateMapping: mock(async () => {
        calls.push('updateMapping');
        return updatedRow;
      }),
      insertAudit: mock(async () => {
        calls.push('insertAudit');
      }),
      upsertProfile: mock(async () => {
        calls.push('upsertProfile');
      }),
    });

    await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.upsertProfile).toHaveBeenCalledTimes(1);
    expect(deps.upsertProfile).toHaveBeenCalledWith(profile);
    expect(calls).toEqual(['updateMapping', 'insertAudit', 'upsertProfile']);
  });

  test('verified verdict with no profile in payload: upsertProfile is NOT called', async () => {
    const e = existing();
    const p = verifiedExact(); // no profile attached
    const deps = makeDeps();

    await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.upsertProfile).not.toHaveBeenCalled();
  });

  test('public_body verdict: upsertProfile is NOT called even if profile somehow present', async () => {
    const e = existing();
    const p: ProposedResolution = {
      verdict: 'public_body',
      companyNumber: null,
      matchMethod: 'public_body',
      matchScore: null,
      queryUsed: 'NHS WHATEVER TRUST',
      profile, // shouldn't matter — public_body never has a CH entity
    };
    const deps = makeDeps();

    await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.upsertProfile).not.toHaveBeenCalled();
  });

  test('no_match verdict: upsertProfile is NOT called', async () => {
    const e = existing();
    const p: ProposedResolution = {
      verdict: 'no_match',
      companyNumber: null,
      matchMethod: 'no_match',
      matchScore: null,
      queryUsed: 'NEVER FOUND LTD',
    };
    const deps = makeDeps();

    await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.upsertProfile).not.toHaveBeenCalled();
  });
});

describe('applyPromotion — public_body promotion shape', () => {
  test('no_match → public_body: updateMapping called with newIsPublicBody=true and null company_number', async () => {
    const e = existing({ matchMethod: 'no_match', companyNumber: null });
    const p: ProposedResolution = {
      verdict: 'public_body',
      companyNumber: null,
      matchMethod: 'public_body',
      matchScore: null,
      queryUsed: 'NHS BRISTOL ICB',
    };
    const deps = makeDeps({
      updateMapping: mock(
        async (): Promise<MappingUpdateResult> => ({
          organisationName: 'ACME LTD',
          newCompanyNumber: null,
          newMatchMethod: 'public_body',
        }),
      ),
    });

    const result = await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.updateMapping).toHaveBeenCalledWith({
      organisationName: 'ACME LTD',
      originalVerifiedAt: e.verifiedAt,
      newCompanyNumber: null,
      newMatchMethod: 'public_body',
      newMatchScore: null,
      newQueryUsed: 'NHS BRISTOL ICB',
      newIsPublicBody: true,
    });
    expect(deps.insertAudit).toHaveBeenCalledTimes(1);
    expect(deps.upsertProfile).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });
});

describe('applyPromotion — lock missed', () => {
  test('updateMapping returns null: no audit, no profile upsert, returns lock_missed', async () => {
    const e = existing();
    const p = verifiedExact();
    const deps = makeDeps({
      updateMapping: mock(async () => null),
    });

    const result = await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.updateMapping).toHaveBeenCalledTimes(1);
    expect(deps.insertAudit).not.toHaveBeenCalled();
    expect(deps.upsertProfile).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'lock_missed' });
  });
});

describe('applyPromotion — audit row', () => {
  test('successful update inserts one audit row capturing old + new state', async () => {
    const e = existing({
      matchMethod: 'no_match',
      companyNumber: null,
    });
    const p = verifiedExact({
      companyNumber: '12345678',
      matchMethod: 'exact',
    });
    const deps = makeDeps();

    await applyPromotion(e, p, 'phase5_sweep_no_match', deps);

    expect(deps.insertAudit).toHaveBeenCalledTimes(1);
    expect(deps.insertAudit).toHaveBeenCalledWith({
      organisationName: 'ACME LTD',
      oldCompanyNumber: null,
      newCompanyNumber: '12345678',
      oldMatchMethod: 'no_match',
      newMatchMethod: 'exact',
      changedBy: 'phase5_sweep_no_match',
    });
  });
});
