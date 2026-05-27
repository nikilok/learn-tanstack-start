import { describe, expect, test } from 'bun:test';

import type { ScorerCandidate, ScorerSponsor } from './score-candidate.ts';
import { scoreCandidate } from './score-candidate.ts';

const candidate = (over: Partial<ScorerCandidate> = {}): ScorerCandidate => ({
  company_status: 'active',
  type: 'ltd',
  registered_office_address: { locality: 'London' },
  ...over,
});

const sponsor = (over: Partial<ScorerSponsor> = {}): ScorerSponsor => ({
  route: 'Skilled Worker',
  townCity: 'London',
  ...over,
});

describe('hard gate: routeTypeCompatible', () => {
  test('Charity Worker + ltd candidate → -Infinity', () => {
    const result = scoreCandidate(
      candidate({ type: 'ltd' }),
      sponsor({ route: 'Charity Worker' }),
    );
    expect(result).toBe(Number.NEGATIVE_INFINITY);
  });

  test('Charity Worker + charitable-incorporated-organisation → finite', () => {
    const result = scoreCandidate(
      candidate({ type: 'charitable-incorporated-organisation' }),
      sponsor({ route: 'Charity Worker' }),
    );
    expect(Number.isFinite(result)).toBe(true);
  });

  test('Skilled Worker + ltd → finite', () => {
    const result = scoreCandidate(
      candidate({ type: 'ltd' }),
      sponsor({ route: 'Skilled Worker' }),
    );
    expect(Number.isFinite(result)).toBe(true);
  });

  test('null company_type → passes the gate (no info, no hard fail)', () => {
    const result = scoreCandidate(
      candidate({ type: null }),
      sponsor({ route: 'Charity Worker' }),
    );
    expect(Number.isFinite(result)).toBe(true);
  });

  test('unknown route → passes the gate (data-drift safety)', () => {
    const result = scoreCandidate(
      candidate({ type: 'ltd' }),
      sponsor({ route: 'Some New Route We Have Not Mapped' }),
    );
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('locality match', () => {
  test('candidate.locality === sponsor.townCity → +3', () => {
    const base = scoreCandidate(
      candidate({
        company_status: null,
        registered_office_address: { locality: 'Manchester' },
      }),
      sponsor({ townCity: 'London' }),
    );
    const matched = scoreCandidate(
      candidate({
        company_status: null,
        registered_office_address: { locality: 'London' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(matched - base).toBe(3);
  });

  test('locality match is case-insensitive', () => {
    const matched = scoreCandidate(
      candidate({
        company_status: null,
        registered_office_address: { locality: 'LONDON' },
      }),
      sponsor({ townCity: 'london' }),
    );
    expect(matched).toBe(3);
  });

  test('missing candidate locality → no locality contribution', () => {
    const result = scoreCandidate(
      candidate({
        company_status: null,
        registered_office_address: { locality: null },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result).toBe(0);
  });

  test('missing sponsor townCity → no locality contribution', () => {
    const result = scoreCandidate(
      candidate({
        company_status: null,
        registered_office_address: { locality: 'London' },
      }),
      sponsor({ townCity: null }),
    );
    expect(result).toBe(0);
  });
});

describe('status weighting', () => {
  test('active → +1', () => {
    const result = scoreCandidate(
      candidate({
        company_status: 'active',
        registered_office_address: null,
      }),
      sponsor({ townCity: null }),
    );
    expect(result).toBe(1);
  });

  test('dissolved → -2', () => {
    const result = scoreCandidate(
      candidate({
        company_status: 'dissolved',
        registered_office_address: null,
      }),
      sponsor({ townCity: null }),
    );
    expect(result).toBe(-2);
  });

  test('liquidation → -2', () => {
    const result = scoreCandidate(
      candidate({
        company_status: 'liquidation',
        registered_office_address: null,
      }),
      sponsor({ townCity: null }),
    );
    expect(result).toBe(-2);
  });

  test('unknown/null status → 0', () => {
    const result = scoreCandidate(
      candidate({ company_status: null, registered_office_address: null }),
      sponsor({ townCity: null }),
    );
    expect(result).toBe(0);
  });
});

describe('combined max', () => {
  test('active + matching locality → +4', () => {
    const result = scoreCandidate(
      candidate({
        company_status: 'active',
        registered_office_address: { locality: 'London' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result).toBe(4);
  });

  test('dissolved + non-matching locality → -2', () => {
    const result = scoreCandidate(
      candidate({
        company_status: 'dissolved',
        registered_office_address: { locality: 'Edinburgh' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result).toBe(-2);
  });
});
