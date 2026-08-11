import { describe, expect, test } from 'bun:test';

import { makeClaimOrigins, makeReleaseClaims, makeRenewClaims } from './claims';

type Db = Parameters<typeof makeClaimOrigins>[0];

/** Stub for the claim upsert chain: records each statement's origins and
 *  grants whatever wins `decide` allows, like contested rows would. */
function stubClaimDb(decide: (origins: string[]) => string[]) {
  const statements: string[][] = [];
  const conflicts: unknown[] = [];
  const db = {
    insert: () => ({
      values: (rows: { origin: string }[]) => ({
        onConflictDoUpdate: (config: unknown) => {
          conflicts.push(config);
          return {
            returning: () => {
              const origins = rows.map((row) => row.origin);
              statements.push(origins);
              return Promise.resolve(
                decide(origins).map((origin) => ({ origin })),
              );
            },
          };
        },
      }),
    }),
  } as unknown as Db;
  return { db, statements, conflicts };
}

/** Stub for the release/renew chains: records each where predicate so the
 *  claimed_by guard's presence is asserted, not assumed. */
function stubRowsDb(result: { origin: string }[]) {
  const wheres: unknown[] = [];
  const rows = () => Promise.resolve(result);
  const capture = (where: unknown) => {
    wheres.push(where);
    return { returning: rows };
  };
  const db = {
    delete: () => ({ where: capture }),
    update: () => ({ set: () => ({ where: capture }) }),
  } as unknown as Db;
  return { db, wheres };
}

/** Column names referenced anywhere in a drizzle condition tree. */
function columnNames(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (typeof record.name === 'string' && record.table) out.push(record.name);
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) columnNames(chunk, out);
  }
  return out;
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

  test('a repeated origin claims once, never a same-row conflict', async () => {
    const { db, statements } = stubClaimDb((origins) => origins);
    const won = await makeClaimOrigins(db)('w', ['a', 'b', 'a', 'a'], 4);
    expect(statements).toEqual([['a', 'b']]);
    expect(won).toEqual(['a', 'b']);
  });

  test('the claim upsert takes only rows whose lease has expired', async () => {
    // Without the setWhere guard the upsert would steal origins other workers
    // still hold; this pins the lease predicate into the statement.
    const { db, conflicts } = stubClaimDb((origins) => origins);
    await makeClaimOrigins(db)('w', ['a'], 1);
    const guard = (conflicts[0] as { setWhere?: unknown }).setWhere;
    expect(guard).toBeDefined();
    expect(columnNames(guard)).toContain('claimed_at');
  });
});

describe('makeReleaseClaims', () => {
  test('empty origin list short-circuits without touching the db', async () => {
    expect(await makeReleaseClaims({} as Db)('w', [])).toBe(0);
  });

  test('returns the count of rows actually deleted', async () => {
    const { db } = stubRowsDb([{ origin: 'a' }, { origin: 'b' }]);
    expect(await makeReleaseClaims(db)('w', ['a', 'b', 'c'])).toBe(2);
  });

  test('the delete is guarded by origin AND claimed_by', async () => {
    // Without the claimed_by arm a stale worker's release deletes an origin
    // another worker now holds; this pins the guard into the predicate.
    const { db, wheres } = stubRowsDb([]);
    await makeReleaseClaims(db)('w', ['a']);
    expect(columnNames(wheres[0])).toContain('origin');
    expect(columnNames(wheres[0])).toContain('claimed_by');
  });
});

describe('makeRenewClaims', () => {
  test('empty origin list short-circuits without touching the db', async () => {
    expect(await makeRenewClaims({} as Db)('w', [])).toBe(0);
  });

  test('returns the count of rows actually renewed', async () => {
    const { db } = stubRowsDb([{ origin: 'a' }]);
    expect(await makeRenewClaims(db)('w', ['a', 'b'])).toBe(1);
  });

  test('the renewal is guarded by origin AND claimed_by', async () => {
    const { db, wheres } = stubRowsDb([]);
    await makeRenewClaims(db)('w', ['a']);
    expect(columnNames(wheres[0])).toContain('origin');
    expect(columnNames(wheres[0])).toContain('claimed_by');
  });
});
