import { describe, expect, test } from 'bun:test';

import { makeFakeSql } from './fake-sql';
import { makeRejectSite } from './rejected-site-sql';

const flat = (text: string) => text.replace(/\s+/g, ' ');
const trust = 'https://www.club-trust.org';
const candidates = [
  'https://www.club-trust.org/about',
  'https://www.club.co.uk/',
];
// The row as it was backed up, with its hash then.
const held = {
  companyNumber: '03260168',
  url: trust,
  candidates,
  rowHash: 'e3b0c44298fc1c149afbf4c8996fb924',
};
// The same row backed up without the site anywhere on it.
const clean = { ...held, url: null, candidates: ['https://www.club.co.uk/'] };
const written = [{ company_number: '03260168' }];
const guard = 'WHERE company_number = $2 AND md5(company_websites::text) = $3';

describe('makeRejectSite', () => {
  test('a row on the site is reset and loses the site, only while the whole row is as it was backed up', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(await makeRejectSite(sql)(held, trust)).toBe('reset');
    // No read of its own: the guard is the backed-up row.
    expect(calls).toHaveLength(1);
    const text = flat(calls[0].text);
    expect(text).toContain("url = NULL, status = 'none', evidence = 'none'");
    // Every column it clears is in the hash: checked_at, verified_at and the rest.
    expect(text).toContain(guard);
    expect(calls[0].params).toEqual([
      JSON.stringify(['https://www.club.co.uk/']),
      '03260168',
      held.rowHash,
    ]);
    // The walk marker stays, so the row is not walked again under this version.
    expect(text).not.toContain('walk_version');
  });

  test('a row already reset only loses the site from its candidates, under the same guard', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(await makeRejectSite(sql)({ ...held, url: null }, trust)).toBe(
      'stripped',
    );
    const text = flat(calls[0].text);
    const set = text.slice(text.indexOf(' SET '), text.indexOf(' WHERE '));
    expect(set).toBe(' SET candidates = $1::jsonb');
    expect(text).toContain(guard);
  });

  test('nothing to change writes nothing, once the row is confirmed as backed up', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(await makeRejectSite(sql)(clean, trust)).toBe('unchanged');
    expect(calls).toHaveLength(1);
    const text = flat(calls[0].text);
    expect(text.trim()).toStartWith(
      'SELECT company_number FROM company_websites',
    );
    expect(text).toContain(
      'WHERE company_number = $1 AND md5(company_websites::text) = $2',
    );
    expect(calls[0].params).toEqual(['03260168', held.rowHash]);
  });

  test('a row clean when backed up, given the site by another job since, reports moved, not unchanged', async () => {
    const { sql, calls } = makeFakeSql([]);
    expect(await makeRejectSite(sql)(clean, trust)).toBe('moved');
    expect(flat(calls[0].text)).not.toContain('UPDATE');
  });

  test('a row another job changed since the backup reports so', async () => {
    const { sql } = makeFakeSql([]);
    expect(await makeRejectSite(sql)(held, trust)).toBe('moved');
  });

  test('a row banking no candidates writes none, not JSON null', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(
      await makeRejectSite(sql)({ ...held, candidates: null }, trust),
    ).toBe('reset');
    expect(calls[0].params[0]).toBeNull();
  });
});
