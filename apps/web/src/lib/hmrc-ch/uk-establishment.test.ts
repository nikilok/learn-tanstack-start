import { describe, expect, test } from 'bun:test';

import {
  chooseEstablishment,
  establishmentNumbers,
  isCompanyNumber,
  isOpenEstablishmentOf,
  isOverseasCompany,
  listedEstablishments,
} from './uk-establishment';

/** JPMorgan Chase Bank's one UK establishment, as Companies House gives its profile. */
const profile = (over: Record<string, unknown> = {}) => ({
  company_number: 'BR000746',
  company_name: 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION',
  company_status: 'open',
  type: 'uk-establishment',
  branch_company_details: { parent_company_number: 'FC004891' },
  ...over,
});

describe('chooseEstablishment', () => {
  test('JPMorgan Chase Bank has one open establishment', () => {
    expect(
      chooseEstablishment([
        { company_number: 'BR000746', company_status: 'open' },
      ]),
    ).toEqual({ kind: 'one', establishmentNumber: 'BR000746' });
  });

  test('a closed establishment beside the open one does not count', () => {
    expect(
      chooseEstablishment([
        { company_number: 'BR000001', company_status: 'closed' },
        { company_number: 'BR000746', company_status: 'open' },
      ]),
    ).toEqual({ kind: 'one', establishmentNumber: 'BR000746' });
  });

  test('Caixa Geral de Depositos has two open, so neither is chosen', () => {
    expect(
      chooseEstablishment([
        { company_number: 'BR006261', company_status: 'open' },
        { company_number: 'BR028851', company_status: 'open' },
      ]),
    ).toEqual({ kind: 'several' });
  });

  test.each([
    [[]],
    [[{ company_number: 'BR000001', company_status: 'closed' }]],
    [[{ company_number: 'BR000746/x', company_status: 'open' }]],
    [[{ company_status: 'open' }]],
  ])('none open, or none with a number, is none: %j', (items) => {
    expect(chooseEstablishment(items)).toEqual({ kind: 'none' });
  });
});

describe('isOpenEstablishmentOf', () => {
  test('the open establishment the register links to the company', () => {
    expect(isOpenEstablishmentOf(profile(), 'FC004891')).toBe(true);
  });

  test.each([
    ['another company', profile(), 'FC000002'],
    ['closed', profile({ company_status: 'closed' }), 'FC004891'],
    ['not an establishment', profile({ type: 'oversea-company' }), 'FC004891'],
    ['no link', profile({ branch_company_details: undefined }), 'FC004891'],
    ['a null link', profile({ branch_company_details: null }), 'FC004891'],
  ])('not for %s', (_label, given, companyNumber) => {
    expect(isOpenEstablishmentOf(given, companyNumber)).toBe(false);
  });
});

describe('isOverseasCompany', () => {
  // Three of the overseas companies sponsors were joined to are SF numbers and one NF: the prefix does not say.
  test('by the type the register gives, whatever the number', () => {
    expect(isOverseasCompany({ type: 'oversea-company' })).toBe(true);
    expect(isOverseasCompany(profile())).toBe(false);
    expect(isOverseasCompany({ type: 'ltd' })).toBe(false);
    expect(isOverseasCompany({})).toBe(false);
  });
});

describe('isCompanyNumber', () => {
  test.each([
    ['FC004891', true],
    ['00445790', true],
    ['BR000746/x', false],
    ['', false],
    [746, false],
    [null, false],
  ])('%j: %s', (value, expected) => {
    expect(isCompanyNumber(value)).toBe(expected);
  });
});

describe('listedEstablishments', () => {
  const items = [{ company_number: 'BR000746', company_status: 'open' }];

  test("the list in Companies House's answer", () => {
    expect(listedEstablishments({ kind: 'related-companies', items })).toEqual(
      items,
    );
  });

  // Dennison Trailers (FC021303) answers with an empty list; a 404 reaches here as no answer.
  test.each([
    [{ items: [] }],
    [{ kind: 'related-companies' }],
    [{ items: null }],
    [null],
    [undefined],
  ])('no establishment listed: %j', (answer) => {
    expect(listedEstablishments(answer)).toEqual([]);
  });

  test.each([[{ items: 'none' }], [{ items: {} }], [{ items: 3 }]])(
    'a list that is no list says nothing: %j',
    (answer) => {
      expect(listedEstablishments(answer)).toBeNull();
    },
  );
});

describe('establishmentNumbers', () => {
  test('every establishment listed, open or not, and none without a number', () => {
    expect(
      establishmentNumbers([
        { company_number: 'BR000001', company_status: 'closed' },
        { company_number: 'BR000746', company_status: 'open' },
        { company_number: 'BR000746/x', company_status: 'open' },
        { company_status: 'open' },
      ]),
    ).toEqual(['BR000001', 'BR000746']);
  });
});
