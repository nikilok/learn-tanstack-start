import { describe, expect, test } from 'bun:test';

import {
  isUnsupportedNameOnlyMatch,
  type NameOnlyMatch,
} from './name-only-guard';

/** A bare register name matched exactly to a suffixed, active company in another town. */
function match(overrides: Partial<NameOnlyMatch> = {}): NameOnlyMatch {
  return {
    legalName: 'Northgate Bakery',
    registerNumber: null,
    matchMethod: 'exact',
    companyNumber: '00000042',
    companyName: 'NORTHGATE BAKERY LIMITED',
    companyStatus: 'active',
    office: {
      address_line_1: '4 Mill Lane',
      locality: 'Leeds',
      region: 'West Yorkshire',
    },
    townCity: 'Exeter',
    county: null,
    ...overrides,
  };
}

describe('isUnsupportedNameOnlyMatch', () => {
  test('a bare name on a suffixed company in another town is unsupported', () => {
    expect(isUnsupportedNameOnlyMatch(match())).toBe(true);
  });

  test.each(['exact', 'exact_squash', 'previous_name', 'token_sim'])(
    'holds for the %s method',
    (matchMethod) => {
      expect(isUnsupportedNameOnlyMatch(match({ matchMethod }))).toBe(true);
    },
  );

  test('a fuzzy match is left to its own locality gate', () => {
    expect(
      isUnsupportedNameOnlyMatch(match({ matchMethod: 'fuzzy_edit' })),
    ).toBe(false);
  });

  test.each([
    'Northgate Bakery Ltd',
    'Northgate Bakery Limited',
    'Northgate Bakery LLP',
    'Northgate Bakery Ltd.',
    'Northgate Bakery (UK) Limited',
    'Northgate Bakery Ltd,',
    'Northgate Bakery Limited.,',
    'Northgate Bakery LLP , ',
  ])('a register name with its own suffix is supported: %s', (legalName) => {
    expect(isUnsupportedNameOnlyMatch(match({ legalName }))).toBe(false);
  });

  test("a register name that carries the company's own number is supported", () => {
    expect(
      isUnsupportedNameOnlyMatch(match({ registerNumber: '00000042' })),
    ).toBe(false);
  });

  test("another company's number in the register name supports nothing", () => {
    expect(
      isUnsupportedNameOnlyMatch(match({ registerNumber: '00000077' })),
    ).toBe(true);
  });

  test('a town pieced together across two parts of the office is not the town', () => {
    expect(
      isUnsupportedNameOnlyMatch(
        match({
          townCity: 'West Bromwich',
          office: {
            address_line_1: '12 High Street West',
            locality: 'Bromwich',
          },
        }),
      ),
    ).toBe(true);
    expect(
      isUnsupportedNameOnlyMatch(
        match({
          townCity: 'West Bromwich',
          office: { address_line_1: '12 High Street, West Bromwich' },
        }),
      ),
    ).toBe(false);
  });

  test.each([
    'NORTHGATE BAKERY C.I.C.',
    'NORTHGATE BAKERY COMMUNITY INTEREST COMPANY',
    'NORTHGATE BAKERY P.L.C.',
    'NORTHGATE BAKERY PUBLIC LIMITED COMPANY',
    'NORTHGATE BAKERY L.L.P.',
    'NORTHGATE BAKERY LIMITED LIABILITY PARTNERSHIP',
    'NORTHGATE BAKERY LIMITED PARTNERSHIP',
  ])('a bare name on %s in another town is unsupported', (companyName) => {
    expect(isUnsupportedNameOnlyMatch(match({ companyName }))).toBe(true);
  });

  test.each([
    'Northgate Bakery C.I.C.',
    'Northgate Bakery Community Interest Company',
  ])(
    'a register name with a spelt-out suffix is supported: %s',
    (legalName) => {
      expect(isUnsupportedNameOnlyMatch(match({ legalName }))).toBe(false);
    },
  );

  test('a company with no suffix of its own is supported', () => {
    expect(
      isUnsupportedNameOnlyMatch(match({ companyName: 'NORTHGATE BAKERY' })),
    ).toBe(false);
  });

  test.each([
    { locality: 'Exeter' },
    { address_line_1: '2 King Street, Exeter' },
    { address_line_2: 'EXETER' },
    { premises: 'Unit 2, Exeter' },
    { region: 'exeter' },
    { locality: 'Topsham Exeter' },
  ])(
    'the town at the end of any part of the office supports it: %o',
    (office) => {
      expect(isUnsupportedNameOnlyMatch(match({ office }))).toBe(false);
    },
  );

  test('a town that only begins a part of the office is not the town', () => {
    const held = (townCity: string, office: NameOnlyMatch['office']) =>
      isUnsupportedNameOnlyMatch(match({ townCity, office }));
    expect(held('Newport', { locality: 'Newport Pagnell' })).toBe(true);
    expect(
      held('Exeter', { premises: 'Exeter House', locality: 'Leeds' }),
    ).toBe(true);
    expect(held('London', { address_line_1: '12 London St., Sheffield' })).toBe(
      true,
    );
    expect(held('Newport', { locality: 'Newport' })).toBe(false);
  });

  test("the town as a street's name is not the town", () => {
    const london = (office: NameOnlyMatch['office']) =>
      isUnsupportedNameOnlyMatch(match({ townCity: 'London', office }));
    expect(
      london({ address_line_1: '12 London Road', locality: 'Sheffield' }),
    ).toBe(true);
    expect(london({ premises: 'London Street', locality: 'Reading' })).toBe(
      true,
    );
    // The town itself, beside or after a street of its name, still counts.
    expect(
      london({ address_line_1: '12 London Road', locality: 'London' }),
    ).toBe(false);
    expect(london({ address_line_1: '5 High Street, London' })).toBe(false);
    expect(london({ address_line_1: 'London Road, London' })).toBe(false);
  });

  test('the town inside a longer word is not the town', () => {
    expect(
      isUnsupportedNameOnlyMatch(
        match({ townCity: 'Hull', office: { locality: 'Solihull' } }),
      ),
    ).toBe(true);
  });

  test('punctuation, case and accents do not hide the town', () => {
    expect(
      isUnsupportedNameOnlyMatch(
        match({ townCity: 'St. Albans', office: { locality: 'ST ALBANS' } }),
      ),
    ).toBe(false);
    expect(
      isUnsupportedNameOnlyMatch(
        match({ townCity: 'Llanbedrog', office: { locality: 'Llanbedrôg' } }),
      ),
    ).toBe(false);
  });

  test('any part of a town field that lists two places supports it', () => {
    expect(
      isUnsupportedNameOnlyMatch(
        match({ townCity: 'Topsham, Exeter', office: { locality: 'Topsham' } }),
      ),
    ).toBe(false);
  });

  test('a short place counts only as a whole part of the office', () => {
    const held = (office: NameOnlyMatch['office']) =>
      isUnsupportedNameOnlyMatch(match({ townCity: 'Ae', office }));
    expect(held({ locality: 'Ae' })).toBe(false);
    expect(held({ address_line_1: 'Ae Forest' })).toBe(true);
    expect(held({ address_line_1: '3 Mill Road, Ae' })).toBe(true);
  });

  test('the county supports an active company', () => {
    expect(
      isUnsupportedNameOnlyMatch(match({ county: 'West Yorkshire' })),
    ).toBe(false);
  });

  test.each(['dissolved', 'liquidation', 'converted-closed', null, undefined])(
    'the county does not support a company that is %s',
    (companyStatus) => {
      expect(
        isUnsupportedNameOnlyMatch(
          match({ county: 'West Yorkshire', companyStatus }),
        ),
      ).toBe(true);
    },
  );

  test('the town supports a dissolved company', () => {
    expect(
      isUnsupportedNameOnlyMatch(
        match({ companyStatus: 'dissolved', townCity: 'Leeds' }),
      ),
    ).toBe(false);
  });

  test.each([null, undefined, {}])(
    'a company with no office is unsupported: %o',
    (office) => {
      expect(isUnsupportedNameOnlyMatch(match({ office }))).toBe(true);
    },
  );

  test('a sponsor with no place on the register is unsupported', () => {
    expect(
      isUnsupportedNameOnlyMatch(match({ townCity: null, county: null })),
    ).toBe(true);
  });
});
