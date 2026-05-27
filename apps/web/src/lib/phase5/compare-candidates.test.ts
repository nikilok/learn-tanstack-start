import { describe, expect, test } from 'bun:test';

import type { CompareCandidate } from './compare-candidates.ts';
import {
  compareForInlineResolution,
  SCORE_MARGIN,
  STATUS_QUO_BONUS,
} from './compare-candidates.ts';
import type { ScorerSponsor } from './score-candidate.ts';

const candidate = (over: Partial<CompareCandidate> = {}): CompareCandidate => ({
  company_name: 'ACME LTD',
  company_status: 'active',
  type: 'ltd',
  registered_office_address: { locality: 'London' },
  previous_company_names: null,
  ...over,
});

const sponsor = (over: Partial<ScorerSponsor> = {}): ScorerSponsor => ({
  route: 'Skilled Worker',
  townCity: 'London',
  ...over,
});

describe('status-quo bias', () => {
  test('identical sponsor-fit scores → inconclusive (bias < SCORE_MARGIN)', () => {
    const result = compareForInlineResolution(
      candidate({ company_name: 'EXISTING LTD' }),
      candidate({ company_name: 'PROPOSED LTD' }),
      sponsor(),
    );
    expect(result.action).toBe('inconclusive');
    expect(result.s_e - result.s_p).toBe(STATUS_QUO_BONUS);
  });
});

describe('succession evidence — forward (existing renamed to proposed)', () => {
  test('canonical(existing.name) in proposed.previous_company_names → s_p wins', () => {
    const result = compareForInlineResolution(
      candidate({
        company_name: 'OLD NAME LIMITED',
        registered_office_address: { locality: 'Manchester' },
      }),
      candidate({
        company_name: 'NEW NAME LIMITED',
        registered_office_address: { locality: 'Manchester' },
        previous_company_names: [{ name: 'Old Name Ltd' }],
      }),
      sponsor({ townCity: 'Manchester' }),
    );
    expect(result.action).toBe('promote');
  });
});

describe('succession evidence — reverse (proposed previously known as existing)', () => {
  test('canonical(proposed.name) in existing.previous_company_names → s_e wins', () => {
    const result = compareForInlineResolution(
      candidate({
        company_name: 'CURRENT NAME LIMITED',
        registered_office_address: { locality: 'Manchester' },
        previous_company_names: [{ name: 'Reverse Name Ltd' }],
      }),
      candidate({
        company_name: 'REVERSE NAME LIMITED',
        registered_office_address: { locality: 'Manchester' },
      }),
      sponsor({ townCity: 'Manchester' }),
    );
    expect(result.action).toBe('keep');
  });
});

describe('SCORE_MARGIN threshold', () => {
  test('locality-only difference (diff=3) → NOT enough to swing', () => {
    const result = compareForInlineResolution(
      candidate({
        company_status: null,
        registered_office_address: { locality: 'Edinburgh' },
      }),
      candidate({
        company_status: null,
        registered_office_address: { locality: 'London' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result.s_p - (result.s_e - STATUS_QUO_BONUS)).toBe(3);
    expect(result.action).toBe('inconclusive');
  });

  test('locality + active vs neither (diff=4) → promote', () => {
    const result = compareForInlineResolution(
      candidate({
        company_status: null,
        registered_office_address: { locality: 'Edinburgh' },
      }),
      candidate({
        company_status: 'active',
        registered_office_address: { locality: 'London' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result.action).toBe('promote');
    expect(result.s_p - result.s_e).toBeGreaterThan(SCORE_MARGIN);
  });

  test('reverse case: existing strongly wins → keep', () => {
    const result = compareForInlineResolution(
      candidate({
        company_status: 'active',
        registered_office_address: { locality: 'London' },
      }),
      candidate({
        company_status: 'dissolved',
        registered_office_address: { locality: 'Edinburgh' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result.action).toBe('keep');
  });
});

describe('hard gate plumbing through', () => {
  test('existing scores -Infinity (route-incompatible) → any finite proposed wins', () => {
    const result = compareForInlineResolution(
      candidate({ type: 'ltd' }),
      candidate({ type: 'charitable-incorporated-organisation' }),
      sponsor({ route: 'Charity Worker' }),
    );
    expect(result.action).toBe('promote');
    expect(result.s_e).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isFinite(result.s_p)).toBe(true);
  });

  test('proposed scores -Infinity → existing keeps by infinity margin', () => {
    const result = compareForInlineResolution(
      candidate({ type: 'charitable-incorporated-organisation' }),
      candidate({ type: 'ltd' }),
      sponsor({ route: 'Charity Worker' }),
    );
    expect(result.action).toBe('keep');
    expect(result.s_p).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('UK-presence preference (BR ↔ FC / OE)', () => {
  test('60 Decibels-style: FC existing, BR proposed → promote', () => {
    const result = compareForInlineResolution(
      candidate({
        company_name: '60 DECIBELS, INC.',
        type: 'oversea-company',
        company_status: 'active',
        registered_office_address: { locality: 'Delaware' },
      }),
      candidate({
        company_name: '60 DECIBELS, INC.',
        type: 'uk-establishment',
        company_status: 'open',
        registered_office_address: { locality: 'London' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result.action).toBe('promote');
  });

  test('Reverse: BR existing, FC proposed → keep (preserves the 99-row pattern)', () => {
    const result = compareForInlineResolution(
      candidate({
        company_name: 'AIR NEW ZEALAND LIMITED',
        type: 'uk-establishment',
        company_status: 'open',
        registered_office_address: { locality: 'London' },
      }),
      candidate({
        company_name: 'AIR NEW ZEALAND LIMITED',
        type: 'oversea-company',
        company_status: 'active',
        registered_office_address: { locality: 'Auckland' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result.action).toBe('keep');
  });

  test('OE existing (ROE), uk-establishment proposed → promote', () => {
    const result = compareForInlineResolution(
      candidate({
        type: 'registered-overseas-entity',
        company_status: 'registered',
        registered_office_address: { locality: 'Guernsey' },
      }),
      candidate({
        type: 'uk-establishment',
        company_status: 'open',
        registered_office_address: { locality: 'London' },
      }),
      sponsor({ townCity: 'London' }),
    );
    expect(result.action).toBe('promote');
  });

  test('Neither side is uk-establishment → no UK-presence boost applied', () => {
    const result = compareForInlineResolution(
      candidate({
        type: 'ltd',
        company_status: 'active',
        registered_office_address: { locality: 'Manchester' },
      }),
      candidate({
        type: 'ltd',
        company_status: 'active',
        registered_office_address: { locality: 'Manchester' },
      }),
      sponsor({ townCity: 'Manchester' }),
    );
    expect(result.action).toBe('inconclusive');
  });
});

describe('AsiaLink-style regression fixture', () => {
  test('Charity Worker sponsor, existing CIO with no address, proposed ltd elsewhere → keep', () => {
    const result = compareForInlineResolution(
      candidate({
        company_name: 'ASIALINK',
        type: 'charitable-incorporated-organisation',
        company_status: 'active',
        registered_office_address: null,
      }),
      candidate({
        company_name: 'ASIALINK LIMITED',
        type: 'ltd',
        company_status: 'active',
        registered_office_address: { locality: 'Manchester' },
      }),
      sponsor({ route: 'Charity Worker', townCity: 'Northwich' }),
    );
    expect(result.action).toBe('keep');
    expect(result.s_p).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('canonical name normalisation', () => {
  test('matches across LTD / LIMITED / case differences in previous names', () => {
    const result = compareForInlineResolution(
      candidate({
        company_name: 'Acme Foods Ltd',
        registered_office_address: { locality: 'Manchester' },
      }),
      candidate({
        company_name: 'ACME FOODS HOLDINGS LIMITED',
        registered_office_address: { locality: 'Manchester' },
        previous_company_names: [{ name: 'ACME FOODS LIMITED' }],
      }),
      sponsor({ townCity: 'Manchester' }),
    );
    expect(result.action).toBe('promote');
  });
});
