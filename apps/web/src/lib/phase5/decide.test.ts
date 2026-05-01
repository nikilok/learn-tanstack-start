import { describe, expect, test } from 'bun:test';
import type { ExistingMapping, ProposedResolution } from './decide.ts';
import { decide } from './decide.ts';

const existing = (over: Partial<ExistingMapping> = {}): ExistingMapping => ({
  organisationName: 'ACME LTD',
  companyNumber: '12345678',
  matchMethod: 'exact',
  matchScore: '1.000',
  verifiedAt: new Date('2026-01-01T00:00:00Z'),
  isPublicBody: false,
  ...over,
});

const proposed = (
  over: Partial<ProposedResolution> = {},
): ProposedResolution => ({
  verdict: 'verified',
  companyNumber: '12345678',
  matchMethod: 'exact',
  matchScore: 1,
  queryUsed: 'ACME LTD',
  ...over,
});

describe('rule 1: human_review never overwrites', () => {
  test('proposed=human_review against existing=exact → bump', () => {
    const result = decide(
      existing({ matchMethod: 'exact' }),
      proposed({ verdict: 'human_review' }),
    );
    expect(result).toEqual({ action: 'bump' });
  });
});

describe('rule 2: manual is sacred', () => {
  test('manual + proposed agrees on company_number → bump', () => {
    const result = decide(
      existing({ matchMethod: 'manual', companyNumber: '12345678' }),
      proposed({ verdict: 'verified', companyNumber: '12345678' }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('manual + proposed differs on company_number → queue manual_conflict', () => {
    const result = decide(
      existing({ matchMethod: 'manual', companyNumber: '12345678' }),
      proposed({ verdict: 'verified', companyNumber: '99999999' }),
    );
    expect(result).toEqual({ action: 'queue', reason: 'manual_conflict' });
  });

  test('manual + proposed=no_match → queue manual_conflict', () => {
    const result = decide(
      existing({ matchMethod: 'manual', companyNumber: '12345678' }),
      proposed({
        verdict: 'no_match',
        companyNumber: null,
        matchMethod: 'no_match',
      }),
    );
    expect(result).toEqual({ action: 'queue', reason: 'manual_conflict' });
  });

  test('manual + proposed=public_body → queue manual_conflict', () => {
    const result = decide(
      existing({ matchMethod: 'manual', companyNumber: '12345678' }),
      proposed({
        verdict: 'public_body',
        companyNumber: null,
        matchMethod: 'public_body',
      }),
    );
    expect(result).toEqual({ action: 'queue', reason: 'manual_conflict' });
  });
});

describe('rule 3: public_body terminal peer', () => {
  test('public_body + public_body → bump', () => {
    const result = decide(
      existing({ matchMethod: 'public_body', companyNumber: null }),
      proposed({
        verdict: 'public_body',
        companyNumber: null,
        matchMethod: 'public_body',
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('public_body + verified → queue public_body_conflict', () => {
    const result = decide(
      existing({ matchMethod: 'public_body', companyNumber: null }),
      proposed({ verdict: 'verified', companyNumber: '12345678' }),
    );
    expect(result).toEqual({ action: 'queue', reason: 'public_body_conflict' });
  });

  test('verified + public_body → queue public_body_conflict', () => {
    const result = decide(
      existing({ matchMethod: 'exact', companyNumber: '12345678' }),
      proposed({
        verdict: 'public_body',
        companyNumber: null,
        matchMethod: 'public_body',
      }),
    );
    expect(result).toEqual({ action: 'queue', reason: 'public_body_conflict' });
  });

  test('no_match + public_body → update (regex hit beats no_match)', () => {
    const result = decide(
      existing({ matchMethod: 'no_match', companyNumber: null }),
      proposed({
        verdict: 'public_body',
        companyNumber: null,
        matchMethod: 'public_body',
      }),
    );
    expect(result).toEqual({ action: 'update' });
  });
});

describe('rule 4: rank promotion (proposed > existing)', () => {
  test('no_match → exact', () => {
    const result = decide(
      existing({ matchMethod: 'no_match', companyNumber: null }),
      proposed({
        verdict: 'verified',
        matchMethod: 'exact',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('no_match → token_sim', () => {
    const result = decide(
      existing({ matchMethod: 'no_match', companyNumber: null }),
      proposed({
        verdict: 'verified',
        matchMethod: 'token_sim',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('token_sim → exact', () => {
    const result = decide(
      existing({ matchMethod: 'token_sim', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'exact',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('previous_name → exact', () => {
    const result = decide(
      existing({ matchMethod: 'previous_name', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'exact',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('token_sim → previous_name', () => {
    const result = decide(
      existing({ matchMethod: 'token_sim', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'previous_name',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('human_review → exact (existing skip rows can promote)', () => {
    const result = decide(
      existing({ matchMethod: null, companyNumber: null }),
      proposed({
        verdict: 'verified',
        matchMethod: 'exact',
        companyNumber: '12345678',
      }),
    );
    // existing.matchMethod === null is the requires_human_review_* skip shape;
    // sweep is allowed to promote it once a clean verified verdict appears.
    expect(result).toEqual({ action: 'update' });
  });
});

describe('rule 5: rank demotion rejected (proposed < existing)', () => {
  test('exact → token_sim → bump', () => {
    const result = decide(
      existing({ matchMethod: 'exact', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'token_sim',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('exact → previous_name → bump', () => {
    const result = decide(
      existing({ matchMethod: 'exact', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'previous_name',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('previous_name → token_sim → bump', () => {
    const result = decide(
      existing({ matchMethod: 'previous_name', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'token_sim',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('exact → no_match → bump', () => {
    const result = decide(
      existing({ matchMethod: 'exact', companyNumber: '12345678' }),
      proposed({
        verdict: 'no_match',
        matchMethod: 'no_match',
        companyNumber: null,
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('token_sim → no_match → bump', () => {
    const result = decide(
      existing({ matchMethod: 'token_sim', companyNumber: '12345678' }),
      proposed({
        verdict: 'no_match',
        matchMethod: 'no_match',
        companyNumber: null,
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });
});

describe('rule 6: same rank', () => {
  test('exact:X → exact:X same number → bump', () => {
    const result = decide(
      existing({ matchMethod: 'exact', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'exact',
        companyNumber: '12345678',
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('exact:X → exact:Y different number → queue same_rank_different_number', () => {
    const result = decide(
      existing({ matchMethod: 'exact', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'exact',
        companyNumber: '99999999',
      }),
    );
    expect(result).toEqual({
      action: 'queue',
      reason: 'same_rank_different_number',
    });
  });

  test('no_match → no_match → bump', () => {
    const result = decide(
      existing({ matchMethod: 'no_match', companyNumber: null }),
      proposed({
        verdict: 'no_match',
        matchMethod: 'no_match',
        companyNumber: null,
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });

  test('token_sim:X different number from token_sim:Y → queue', () => {
    const result = decide(
      existing({ matchMethod: 'token_sim', companyNumber: '12345678' }),
      proposed({
        verdict: 'verified',
        matchMethod: 'token_sim',
        companyNumber: '99999999',
      }),
    );
    expect(result).toEqual({
      action: 'queue',
      reason: 'same_rank_different_number',
    });
  });

  test('token_sim:X with score wobble (same number) → bump, not queue', () => {
    const result = decide(
      existing({
        matchMethod: 'token_sim',
        companyNumber: '12345678',
        matchScore: '0.850',
      }),
      proposed({
        verdict: 'verified',
        matchMethod: 'token_sim',
        companyNumber: '12345678',
        matchScore: 0.92,
      }),
    );
    expect(result).toEqual({ action: 'bump' });
  });
});
