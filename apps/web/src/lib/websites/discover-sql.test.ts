import { describe, expect, test } from 'bun:test';

import { CROWDED_HOST_COMPANIES } from './crowded-hosts';
import { makeCrowdedHosts, makeSelectUndiscovered } from './discover-sql';
import { type FakeSqlCall, makeFakeSql } from './fake-sql';
import { SPONSOR_NAMES_COLUMN, SPONSOR_NAMES_KEY } from './sponsor-names';
import { SPONSOR_TOWNS_COLUMN, SPONSOR_TOWNS_KEY } from './sponsor-towns';

/** The bucket predicate, capturing the placeholders of its count and index. */
const BUCKET =
  /mod\(\s*\('x' \|\| left\(md5\(m\.company_number\), 7\)\)::bit\(28\)::int,\s*\$(\d+)::int\s*\) = \$(\d+)::int/;

/** The count and index the selector bound into its bucket predicate. */
function boundShard(call: FakeSqlCall): { count: unknown; index: unknown } {
  const match = BUCKET.exec(call.text);
  if (!match) throw new Error('bucket predicate missing from the selector');
  return {
    count: call.params[Number(match[1]) - 1],
    index: call.params[Number(match[2]) - 1],
  };
}

describe('makeSelectUndiscovered', () => {
  test("binds the worker's slice into the selector", async () => {
    // Dropping the predicate would not fail loudly: every worker would take
    // the same head of the set and pay for each company once per worker.
    const { sql, calls } = makeFakeSql();
    await makeSelectUndiscovered(sql, { index: 3, count: 12 })(500);
    expect(calls).toHaveLength(1);
    expect(boundShard(calls[0])).toEqual({ count: 12, index: 3 });
  });

  test('defaults to the whole set as bucket 0 of 1', async () => {
    const { sql, calls } = makeFakeSql();
    await makeSelectUndiscovered(sql)(300);
    expect(boundShard(calls[0])).toEqual({ count: 1, index: 0 });
  });

  test("reads the register's towns and the registered locality, the two-signal rule's places", async () => {
    expect(SPONSOR_TOWNS_COLUMN.endsWith(` AS ${SPONSOR_TOWNS_KEY}`)).toBe(
      true,
    );
    const { sql, calls } = makeFakeSql([
      {
        company_number: '09990117',
        locality: 'Harrogate',
        [SPONSOR_TOWNS_KEY]: ['Harrogate', 'Leeds'],
      },
      { company_number: '09990118', locality: null },
    ]);
    const rows = await makeSelectUndiscovered(sql)(10);
    expect(calls[0].text).toContain(SPONSOR_TOWNS_COLUMN);
    // In the select list, not inside the town's coalesce.
    expect(calls[0].text.replace(/\s+/g, ' ')).toContain(
      'AS town, p.locality, p.postal_code,',
    );
    expect(rows.map((r) => [r.registerTowns, r.locality])).toEqual([
      [['Harrogate', 'Leeds'], 'Harrogate'],
      [[], null],
    ]);
  });

  test("reads the sponsor register's names, which a site may name the company by", async () => {
    // Rows are keyed by the column's alias, so the reader's key is the alias.
    expect(SPONSOR_NAMES_COLUMN.endsWith(` AS ${SPONSOR_NAMES_KEY}`)).toBe(
      true,
    );
    const { sql, calls } = makeFakeSql([
      {
        company_number: '03260168',
        company_name: 'ACME WIDGETS LIMITED',
        [SPONSOR_NAMES_KEY]: ['Acme Widgets Ltd T/A Acme Dental'],
      },
      {
        company_number: '03260169',
        company_name: 'ACME TWO LIMITED',
        [SPONSOR_NAMES_KEY]: [],
      },
      { company_number: '03260170', company_name: 'ACME THREE LIMITED' },
    ]);
    const rows = await makeSelectUndiscovered(sql)(10);
    expect(calls[0].text).toContain(SPONSOR_NAMES_COLUMN);
    expect(rows.map((r) => r.sponsorNames)).toEqual([
      ['Acme Widgets Ltd T/A Acme Dental'],
      [],
      [],
    ]);
  });

  test('filters before ordering and limiting', async () => {
    // A slice taken after the LIMIT would hand a worker a fraction of a page
    // and stall it while its own companies wait further down the order.
    const { sql, calls } = makeFakeSql();
    await makeSelectUndiscovered(sql, { index: 0, count: 4 })(10);
    const text = calls[0].text;
    const bucketAt = text.search(BUCKET);
    // The main WHERE: the register-names column has one of its own.
    expect(bucketAt).toBeGreaterThan(
      text.indexOf('WHERE m.company_number IS NOT NULL'),
    );
    expect(text.indexOf('WHERE m.company_number IS NOT NULL')).toBeGreaterThan(
      text.indexOf('FROM hmrc_company_mapping m'),
    );
    expect(bucketAt).toBeLessThan(text.indexOf('ORDER BY'));
    expect(text.indexOf('ORDER BY')).toBeLessThan(text.indexOf('LIMIT'));
  });
});

describe('makeCrowdedHosts', () => {
  test('binds the threshold and strips www as crowdKey does', async () => {
    // Written `'^www\.'` the tagged template would send `'^www.'`, matching
    // any fourth character; the cooked text the fake records shows that.
    const { sql, calls } = makeFakeSql();
    await makeCrowdedHosts(sql)();
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([CROWDED_HOST_COMPANIES]);
    expect(calls[0].text).toContain("'^www[.]'");
  });
});
