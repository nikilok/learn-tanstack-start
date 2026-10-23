import { describe, expect, test } from 'bun:test';

import { CROWDED_HOST_COMPANIES } from './crowded-hosts';
import { makeCrowdedHosts, makeSelectUndiscovered } from './discover-sql';
import { SPONSOR_NAMES_COLUMN } from './sponsor-names';

type Captured = { text: string; params: unknown[] };

/** A raw fragment as the fake client holds it. */
type Raw = { raw: string };
const isRaw = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && 'raw' in value;

/** Fake tagged-template sql client: records each call's text (with $n
 *  placeholders, raw fragments spliced in as the driver does) and params,
 *  resolves with the given rows. */
function makeFakeSql(result: Record<string, unknown>[] = []) {
  const calls: Captured[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    const params: unknown[] = [];
    values.forEach((value, i) => {
      text += isRaw(value) ? value.raw : `$${params.push(value)}`;
      text += strings[i + 1];
    });
    calls.push({ text, params });
    return Promise.resolve(result);
  }) as unknown as Parameters<typeof makeSelectUndiscovered>[0];
  sql.unsafe = (raw: string): Raw => ({ raw });
  return { sql, calls };
}

/** The bucket predicate, capturing the placeholders of its count and index. */
const BUCKET =
  /mod\(\s*\('x' \|\| left\(md5\(m\.company_number\), 7\)\)::bit\(28\)::int,\s*\$(\d+)::int\s*\) = \$(\d+)::int/;

/** The count and index the selector bound into its bucket predicate. */
function boundShard(call: Captured): { count: unknown; index: unknown } {
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

  test("reads the sponsor register's names, which a site may name the company by", async () => {
    const { sql, calls } = makeFakeSql([
      {
        company_number: '03260168',
        company_name: 'ACME WIDGETS LIMITED',
        sponsor_names: ['Acme Widgets Ltd T/A Acme Dental'],
      },
      {
        company_number: '03260169',
        company_name: 'ACME TWO LIMITED',
        sponsor_names: null,
      },
    ]);
    const rows = await makeSelectUndiscovered(sql)(10);
    expect(calls[0].text).toContain(SPONSOR_NAMES_COLUMN);
    expect(rows.map((r) => r.sponsorNames)).toEqual([
      ['Acme Widgets Ltd T/A Acme Dental'],
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
    expect(bucketAt).toBeGreaterThan(text.indexOf('WHERE'));
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
