import { describe, expect, test } from 'bun:test';

import { makeSweepDeps } from './sweep-deps.ts';

/** A database the checks below never reach. */
async function unusedSql(): Promise<Record<string, unknown>[]> {
  throw new Error('no query expected');
}

describe('makeSweepDeps', () => {
  const deps = makeSweepDeps(unusedSql, () => {});
  const footer = (text: string) => `<footer>${text}</footer>`;

  test('the number check reads the statutory wording the token match misses', () => {
    // The re-walk's misses: dropped zeros, a prefix apart from its digits, digit groups.
    expect(
      deps.hasCompanyNumber(footer('Company No. 123456'), '00123456'),
    ).toBe(true);
    expect(
      deps.hasCompanyNumber(
        footer('Registered in England under number OC 123456'),
        'OC123456',
      ),
    ).toBe(true);
    expect(
      deps.hasCompanyNumber(footer('Company No. 0123 4567'), '01234567'),
    ).toBe(true);
  });

  test('a phone number with the same digits is not the number', () => {
    expect(
      deps.hasCompanyNumber(footer('Tel: 020 0123 4567'), '01234567'),
    ).toBe(false);
  });

  test('the postcode check matches the registered office', () => {
    expect(
      deps.hasPostcode('<p>Unit 4, Winchester SO22 5AZ</p>', 'SO22 5AZ'),
    ).toBe(true);
    expect(deps.hasPostcode('<p>Unit 4, Winchester</p>', 'SO22 5AZ')).toBe(
      false,
    );
  });
});
