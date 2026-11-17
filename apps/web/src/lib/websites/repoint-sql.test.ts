import { describe, expect, test } from 'bun:test';

import { companyWebsites } from '@ss/db/schema';

import { makeFakeSql } from './fake-sql';
import type { Repoint } from './repoint';
import { makeRepoint } from './repoint-sql';
import { URL_BOUND } from './url-bound';

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const NEW = 'https://www.quillmere.co.uk';
// The row as it was backed up, with its hash then.
const snapshot = {
  companyNumber: '09990117',
  rowHash: 'e3b0c44298fc1c149afbf4c8996fb924',
};
const written = [{ company_number: '09990117' }];
const move = (over: Partial<Extract<Repoint, { kind: 'move' }>> = {}) =>
  ({
    kind: 'move',
    url: NEW,
    evidenceUrl: `${NEW}/contact`,
    status: 'verified',
    keepLive: false,
    ...over,
  }) as const;

/** The columns a statement assigns, in order. */
function assignedColumns(text: string): string[] {
  const set = text.slice(text.indexOf(' SET ') + 5, text.indexOf(' WHERE '));
  return [...set.matchAll(/(\w+)\s+=/g)].map((m) => m[1]);
}

describe('makeRepoint', () => {
  test('a move writes the new address, its proof page and status, and pins it, only while the whole row is as it was backed up', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(await makeRepoint(sql)(snapshot, move())).toBe('repointed');
    expect(calls).toHaveLength(1);
    const text = flat(calls[0].text);
    expect(text).toStartWith(
      'UPDATE company_websites SET url = $1, evidence_url = $2, status = $3, url_pinned_at = now(),',
    );
    expect(text).toEndWith(
      'WHERE company_number = $4 AND md5(company_websites::text) = $5 RETURNING company_number',
    );
    expect(calls[0].params).toEqual([
      NEW,
      `${NEW}/contact`,
      'verified',
      '09990117',
      snapshot.rowHash,
    ]);
  });

  test('what was learned about the old address goes with it: every column that describes an address is written', async () => {
    const { sql, calls } = makeFakeSql(written);
    await makeRepoint(sql)(snapshot, move());
    const text = flat(calls[0].text);
    // The proof page is set to the new one; the rest go back to where a new address starts.
    expect(text).toContain(
      'checked_at = NULL, failure_count = 0, walk_version = NULL, walk_attempts = 0, walked_at = NULL',
    );
    const assigned = assignedColumns(text);
    expect(Object.keys(URL_BOUND).filter((c) => !assigned.includes(c))).toEqual(
      [],
    );
    // Nothing else of the row is touched: its tier, its source and its banked results stay.
    expect(assigned.sort()).toEqual(
      [
        companyWebsites.url.name,
        companyWebsites.status.name,
        companyWebsites.urlPinnedAt.name,
        ...Object.keys(URL_BOUND),
      ].sort(),
    );
  });

  test('a new address the owner read keeps the last check the row has, and is never given one', async () => {
    const { sql, calls } = makeFakeSql(written);
    await makeRepoint(sql)(snapshot, move({ keepLive: true }));
    const text = flat(calls[0].text);
    // Left as stored either way: a row that renders goes on rendering, and one the sweep has not read still waits for it.
    expect(assignedColumns(text)).not.toContain('checked_at');
    expect(text).toContain(
      'failure_count = 0, walk_version = NULL, walk_attempts = 0, walked_at = NULL',
    );
  });

  test('a move with no proof page clears the old one', async () => {
    const { sql, calls } = makeFakeSql(written);
    await makeRepoint(sql)(snapshot, move({ evidenceUrl: null }));
    expect(calls[0].params[1]).toBeNull();
  });

  test('a pin stamps the row and writes nothing else, under the same guard', async () => {
    const { sql, calls } = makeFakeSql(written);
    expect(await makeRepoint(sql)(snapshot, { kind: 'pin' })).toBe('pinned');
    expect(flat(calls[0].text)).toBe(
      'UPDATE company_websites SET url_pinned_at = now() WHERE company_number = $1 AND md5(company_websites::text) = $2 RETURNING company_number',
    );
    expect(calls[0].params).toEqual(['09990117', snapshot.rowHash]);
  });

  test('a row another job changed since the backup is left, and reported so', async () => {
    for (const change of [move(), { kind: 'pin' } as const]) {
      const { sql } = makeFakeSql([]);
      expect(await makeRepoint(sql)(snapshot, change)).toBe('changed');
    }
  });
});
