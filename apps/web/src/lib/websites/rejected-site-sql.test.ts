import { describe, expect, test } from 'bun:test';

import { makeFakeSql } from './fake-sql';
import { makeRejectSite } from './rejected-site-sql';

const flat = (text: string) => text.replace(/\s+/g, ' ');
const trust = 'https://www.club-trust.org';
const candidates = [
  'https://www.club-trust.org/about',
  'https://www.club.co.uk/',
];
// The row as it was backed up.
const held = {
  companyNumber: '03260168',
  url: trust,
  evidence: 'postcode_on_page',
  candidates,
};
const written = [{ company_number: '03260168' }];

describe('makeRejectSite', () => {
  test('a row on the site is reset and loses the site, only while it holds what was backed up', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(await makeRejectSite(sql)(held, trust)).toBe('reset');
    // No read of its own: the guard is the backed-up row.
    expect(calls).toHaveLength(1);
    const text = flat(calls[0].text);
    expect(text).toContain("url = NULL, status = 'none', evidence = 'none'");
    expect(text).toContain(
      'AND url = $3 AND evidence = $4 AND candidates IS NOT DISTINCT FROM $5::jsonb',
    );
    expect(calls[0].params).toEqual([
      JSON.stringify(['https://www.club.co.uk/']),
      '03260168',
      trust,
      'postcode_on_page',
      JSON.stringify(candidates),
    ]);
    // The walk marker stays, so the row is not walked again under this version.
    expect(text).not.toContain('walk_version');
  });

  test('a row already reset only loses the site from its candidates', async () => {
    const { sql, calls } = makeFakeSql(written);
    const none = { ...held, url: null, evidence: 'none' };
    expect(await makeRejectSite(sql)(none, trust)).toBe('stripped');
    const text = flat(calls[0].text);
    const set = text.slice(text.indexOf(' SET '), text.indexOf(' WHERE '));
    expect(set).toBe(' SET candidates = $1::jsonb');
    expect(text).toContain('url IS NOT DISTINCT FROM $3');
  });

  test('nothing to change writes nothing', async () => {
    const { sql, calls } = makeFakeSql(written);
    const clean = {
      ...held,
      url: null,
      evidence: 'none',
      candidates: ['https://www.club.co.uk/'],
    };
    expect(await makeRejectSite(sql)(clean, trust)).toBe('unchanged');
    expect(calls).toHaveLength(0);
  });

  test('a row another job changed since the backup reports so', async () => {
    const { sql } = makeFakeSql([]);
    expect(await makeRejectSite(sql)(held, trust)).toBe('moved');
  });

  test('a row banking no candidates is guarded on none, not on JSON null', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(
      await makeRejectSite(sql)({ ...held, candidates: null }, trust),
    ).toBe('reset');
    expect(calls[0].params).not.toContain('null');
    expect(calls[0].params.filter((p) => p === null)).toHaveLength(2);
  });
});
