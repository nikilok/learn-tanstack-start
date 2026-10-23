import { describe, expect, test } from 'bun:test';

import { makeFakeSql } from './fake-sql';
import { makeRejectSite } from './rejected-site-sql';

const flat = (text: string) => text.replace(/\s+/g, ' ');
const trust = 'https://www.club-trust.org';
const candidates = [
  'https://www.club-trust.org/about',
  'https://www.club.co.uk/',
];
const held = { url: trust, evidence: 'postcode_on_page', candidates };
const written = [{ company_number: '03260168' }];

describe('makeRejectSite', () => {
  test('a row on the site is reset and loses the site, only while it holds what was read', async () => {
    const { sql, calls } = makeFakeSql([held], written);
    expect(await makeRejectSite(sql)('03260168', trust)).toBe('reset');
    expect(calls).toHaveLength(2);
    const text = flat(calls[1].text);
    expect(text).toContain("url = NULL, status = 'none', evidence = 'none'");
    expect(text).toContain(
      'AND url = $3 AND evidence = $4 AND candidates IS NOT DISTINCT FROM $5::jsonb',
    );
    expect(calls[1].params).toContain(
      JSON.stringify(['https://www.club.co.uk/']),
    );
    expect(calls[1].params).toContain(JSON.stringify(candidates));
    // The walk marker stays, so the row is not walked again under this version.
    expect(text).not.toContain('walk_version');
  });

  test('a row already reset only loses the site from its candidates', async () => {
    const { sql, calls } = makeFakeSql(
      [{ url: null, evidence: 'none', candidates }],
      written,
    );
    expect(await makeRejectSite(sql)('03260168', trust)).toBe('stripped');
    const text = flat(calls[1].text);
    const set = text.slice(text.indexOf(' SET '), text.indexOf(' WHERE '));
    expect(set).toBe(' SET candidates = $1::jsonb');
    expect(text).toContain('url IS NOT DISTINCT FROM $3');
  });

  test('nothing to change writes nothing', async () => {
    const { sql, calls } = makeFakeSql([
      { url: null, evidence: 'none', candidates: ['https://www.club.co.uk/'] },
    ]);
    expect(await makeRejectSite(sql)('03260168', trust)).toBe('unchanged');
    expect(calls).toHaveLength(1);
  });

  test('a missing row, or one another job changed meanwhile, reports so', async () => {
    expect(await makeRejectSite(makeFakeSql().sql)('03260168', trust)).toBe(
      'missing',
    );
    const { sql } = makeFakeSql([held], []);
    expect(await makeRejectSite(sql)('03260168', trust)).toBe('moved');
  });

  test('a row banking no candidates is guarded on none, not on JSON null', async () => {
    const { sql, calls } = makeFakeSql(
      [{ url: trust, evidence: 'postcode_on_page', candidates: null }],
      written,
    );
    expect(await makeRejectSite(sql)('03260168', trust)).toBe('reset');
    expect(calls[1].params).not.toContain('null');
    expect(calls[1].params.filter((p) => p === null)).toHaveLength(2);
  });
});
