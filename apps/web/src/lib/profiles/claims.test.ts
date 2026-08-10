import { describe, expect, test } from 'bun:test';

import { makeClaimOrigins, makeReleaseClaims, makeRenewClaims } from './claims';

type Db = Parameters<typeof makeClaimOrigins>[0];

/** Stub for the claim upsert chain: records each statement's origins and
 *  grants whatever wins `decide` allows, like contested rows would. */
function stubClaimDb(decide: (origins: string[]) => string[]) {
  const statements: string[][] = [];
  const db = {
    insert: () => ({
      values: (rows: { origin: string }[]) => ({
        onConflictDoUpdate: () => ({
          returning: () => {
            const origins = rows.map((row) => row.origin);
            statements.push(origins);
            return Promise.resolve(
              decide(origins).map((origin) => ({ origin })),
            );
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, statements };
}

/** Stub for the release/renew chains, returning a fixed row set. */
function stubRowsDb(result: { origin: string }[]) {
  const rows = () => Promise.resolve(result);
  return {
    delete: () => ({ where: () => ({ returning: rows }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: rows }) }) }),
  } as unknown as Db;
}

describe('makeClaimOrigins', () => {
  test('wins the whole target in one statement when nothing is contested', async () => {
    const { db, statements } = stubClaimDb((origins) => origins);
    const won = await makeClaimOrigins(db)('w', ['a', 'b', 'c'], 3);
    expect(won).toEqual(['a', 'b', 'c']);
    expect(statements).toEqual([['a', 'b', 'c']]);
  });

  test('walks past contested origins in shrinking chunks until the target', async () => {
    const winnable = new Set(['a', 'd', 'f']);
    const { db, statements } = stubClaimDb((origins) =>
      origins.filter((origin) => winnable.has(origin)),
    );
    const won = await makeClaimOrigins(db)(
      'w',
      ['a', 'b', 'c', 'd', 'e', 'f'],
      3,
    );
    expect(won).toEqual(['a', 'd', 'f']);
    // Round 1 asks for 3, wins 1; round 2 asks for the remaining 2; round 3
    // for the last 1 — every candidate offered exactly once, no skips.
    expect(statements).toEqual([['a', 'b', 'c'], ['d', 'e'], ['f']]);
  });

  test('returns what it could win when candidates run out', async () => {
    const { db, statements } = stubClaimDb(() => []);
    const won = await makeClaimOrigins(db)('w', ['a', 'b'], 4);
    expect(won).toEqual([]);
    expect(statements).toEqual([['a', 'b']]);
  });

  test('target 0 issues no statements', async () => {
    const { db, statements } = stubClaimDb((origins) => origins);
    expect(await makeClaimOrigins(db)('w', ['a', 'b'], 0)).toEqual([]);
    expect(statements).toEqual([]);
  });

  test('sorts each statement canonically however the caller ordered input', async () => {
    const { db, statements } = stubClaimDb((origins) => origins);
    const won = await makeClaimOrigins(db)('w', ['z', 'm', 'a'], 3);
    expect(statements).toEqual([['a', 'm', 'z']]);
    expect(won).toEqual(['a', 'm', 'z']);
  });
});

describe('makeReleaseClaims', () => {
  test('empty origin list short-circuits without touching the db', async () => {
    expect(await makeReleaseClaims({} as Db)('w', [])).toBe(0);
  });

  test('returns the count of rows actually deleted', async () => {
    const db = stubRowsDb([{ origin: 'a' }, { origin: 'b' }]);
    expect(await makeReleaseClaims(db)('w', ['a', 'b', 'c'])).toBe(2);
  });
});

describe('makeRenewClaims', () => {
  test('empty origin list short-circuits without touching the db', async () => {
    expect(await makeRenewClaims({} as Db)('w', [])).toBe(0);
  });

  test('returns the count of rows actually renewed', async () => {
    const db = stubRowsDb([{ origin: 'a' }]);
    expect(await makeRenewClaims(db)('w', ['a', 'b'])).toBe(1);
  });
});
