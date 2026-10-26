import { describe, expect, test } from 'bun:test';

import { makeFakeSql } from '../../src/lib/websites/fake-sql.ts';
import { makeSweepDeps } from './sweep-deps.ts';

describe('makeSweepDeps', () => {
  const { sql, calls } = makeFakeSql();
  const deps = makeSweepDeps(sql, () => {});
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

  test('without an officer lookup the officer arm is never re-read', () => {
    expect(deps.officers).toBeUndefined();
    const officers = async () => [];
    expect(makeSweepDeps(sql, () => {}, officers).officers).toBe(officers);
    expect(calls).toEqual([]);
  });

  test('without a renderer no page is read in a browser; with one, the sweep reads what it rendered', async () => {
    expect(deps.renderPage).toBeUndefined();
    let closed = 0;
    const rendered = makeSweepDeps(sql, () => {}, undefined, {
      visit: () => ({
        render: async (url) => ({
          ok: true,
          url: `${url}home`,
          status: 200,
          html: '<p>Rendered</p>',
          attempts: 1,
          attemptedUrl: url,
        }),
        close: async () => {
          closed += 1;
        },
      }),
    });
    expect(await rendered.renderPage?.('https://qmx.co.uk/')).toEqual({
      ok: true,
      url: 'https://qmx.co.uk/home',
      html: '<p>Rendered</p>',
      attemptedUrl: 'https://qmx.co.uk/',
    });
    expect(closed).toBe(1);
    expect(calls).toEqual([]);
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
