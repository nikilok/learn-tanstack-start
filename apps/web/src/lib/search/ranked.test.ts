import { describe, expect, test } from 'bun:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { rankedRestriction } from './ranked';

describe('rankedRestriction', () => {
  test('binds the ids once for the condition and once for the order', () => {
    const dialect = new PgDialect();
    const { cond, orderBy } = rankedRestriction(['B', 'A']);
    const c = dialect.sqlToQuery(cond);
    const o = dialect.sqlToQuery(orderBy);
    expect(c.sql).toBe('c.company_number = ANY($1::text[])');
    expect(c.params).toEqual([['B', 'A']]);
    expect(o.sql).toBe(
      'array_position($1::text[], c.company_number::text) ASC, min(h.hash) ASC',
    );
    expect(o.params).toEqual([['B', 'A']]);
  });
});
