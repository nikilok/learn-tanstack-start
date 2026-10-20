import { describe, expect, test } from 'bun:test';

import {
  MAX_STATED_PER_PAGE,
  normaliseStatedNumber,
  statedCompanyNumbers,
} from './stated-numbers';

const numbers = (html: string) =>
  statedCompanyNumbers(html).map((s) => s.companyNumber);
const footer = (text: string) =>
  `<html><body><footer>${text}</footer></body></html>`;

describe('statedCompanyNumbers', () => {
  test('reads the common footer wordings', () => {
    expect(numbers(footer('Acme Ltd. Company No. 03260168'))).toEqual([
      '03260168',
    ]);
    expect(
      numbers(footer('Company number: 6878814 VAT number: 970809593')),
    ).toEqual(['06878814']);
    expect(
      numbers(
        footer('Acme Limited, registered in England and Wales No. 1693250'),
      ),
    ).toEqual(['01693250']);
    expect(
      numbers(
        footer('Registered in England & Wales with company number 12345678.'),
      ),
    ).toEqual(['12345678']);
    expect(
      numbers(
        footer(
          'We are a limited company registered in England and Wales under registration number 12285749',
        ),
      ),
    ).toEqual(['12285749']);
    expect(
      numbers(footer('Registered No. SC507737, Registered address: Glasgow')),
    ).toEqual(['SC507737']);
  });

  test('reads the looser wordings sites use', () => {
    expect(
      numbers(footer('Company Registration: 3970826 Other Information')),
    ).toEqual(['03970826']);
    expect(
      numbers(footer('Company reg. 13433695 VAT No.: 413 2626 30')),
    ).toEqual(['13433695']);
    expect(
      numbers(
        footer(
          'Acme is an English company (no.10357400) with its registered office',
        ),
      ),
    ).toEqual(['10357400']);
    expect(
      numbers(
        footer(
          'Acme Lodge is a public company SC610054 with registered address',
        ),
      ),
    ).toEqual(['SC610054']);
  });

  test('reads a group site naming several companies', () => {
    const html = footer(
      'Registration number: 12086338 (Acme Group Limited) and 11252565 (Acme Mobile Limited). ' +
        'Acme Holdings Limited (03135910) and/or any of its group. Acme Global (CDL) Limited 02884211 UK',
    );
    expect(numbers(html).sort()).toEqual([
      '02884211',
      '03135910',
      '11252565',
      '12086338',
    ]);
  });

  test('joins a number written in digit groups', () => {
    expect(numbers(footer('Company No. 128 936 86'))).toEqual(['12893686']);
    expect(numbers(footer('Company No. 490 4492'))).toEqual(['04904492']);
  });

  test('a charity number inside a registration lead-in is not a company number', () => {
    expect(
      numbers(footer('Registered in England and Wales, Charity No. 1098765')),
    ).toEqual([]);
  });

  test('the register named nearest the number decides, within its clause', () => {
    expect(
      numbers(footer('Registered Charity No. 1188094, Company No. 11074784')),
    ).toEqual(['11074784']);
    expect(
      numbers(
        footer('Registered charity number 279057. Registered number 01436945'),
      ),
    ).toEqual(['01436945']);
  });

  test('leaves other registers alone', () => {
    expect(
      numbers(
        footer(
          'Registered in Scotland SC187424. Registered Scottish Charity SC040590',
        ),
      ),
    ).toEqual(['SC187424']);
    expect(
      numbers(footer('Company Reg : 8418376 | Vat Reg : 157 4531 03')),
    ).toEqual(['08418376']);
    expect(numbers(footer('VAT Reg No 1234567'))).toEqual([]);
    expect(
      numbers(
        footer(
          'Registered charity number 279057. Registered number 01436945 England.',
        ),
      ),
    ).toEqual(['01436945']);
    expect(numbers(footer('FCA registration number 123456'))).toEqual([]);
  });

  test("a listing's 'Companies House number' beside another company is not the site naming itself", () => {
    expect(
      numbers(
        footer(
          'Company name ACME LTD Companies House number 11263776 CH Status Active',
        ),
      ),
    ).toEqual([]);
  });

  test('reads through markup and character references', () => {
    expect(
      numbers('<p>Company&nbsp;No.&nbsp;<strong>0326</strong>0168</p>'),
    ).toEqual(['03260168']);
  });

  test('keeps the statutory wording as evidence', () => {
    const [stated] = statedCompanyNumbers(
      footer('© 2026 Acme Ltd. Company No. 03260168'),
    );
    expect(stated.context).toContain('Company No. 03260168');
  });

  test('a page stating more numbers than any group lists is a listing', () => {
    const many = Array.from(
      { length: MAX_STATED_PER_PAGE + 1 },
      (_, i) => `Company No. ${String(10000000 + i)}`,
    ).join('<br>');
    expect(numbers(footer(many))).toEqual([]);
  });
});

describe('normaliseStatedNumber', () => {
  test('pads numeric numbers and joins prefixed ones', () => {
    expect(normaliseStatedNumber('3260168')).toBe('03260168');
    expect(normaliseStatedNumber('sc 187424')).toBe('SC187424');
  });

  test('keeps the one prefix with a digit in it, R0', () => {
    expect(normaliseStatedNumber('R0 123456')).toBe('R0123456');
    expect(numbers(footer('Company No. R0123456'))).toEqual(['R0123456']);
    // Only R0: a letter and seven digits is no register's form.
    expect(normaliseStatedNumber('A1234567')).toBeNull();
  });

  test('refuses what cannot be a company number', () => {
    expect(normaliseStatedNumber('00000000')).toBeNull();
    expect(normaliseStatedNumber('12345')).toBeNull();
    expect(normaliseStatedNumber('123456789')).toBeNull();
  });
});
