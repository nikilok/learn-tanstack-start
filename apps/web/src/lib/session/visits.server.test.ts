import { describe, expect, spyOn, test } from 'bun:test';

import { hourBucket } from './token.server';
import { recordCompanyVisit, type VisitStore } from './visits.server';

type Row = { sessionId: string; slug: string; hour: Date };

/** A store over a fixed set of company slugs that records what was asked of it. */
function fakeStore(known: string[], opts: { insertFails?: boolean } = {}) {
  const lookups: string[] = [];
  const inserts: Row[] = [];
  const store: VisitStore = {
    async companyPageExists(slug) {
      lookups.push(slug);
      return known.includes(slug);
    },
    async insertVisit(row) {
      if (opts.insertFails) throw new Error('database unavailable');
      inserts.push(row);
    },
  };
  return { store, lookups, inserts };
}

const NOW = Date.UTC(2026, 8, 16, 19, 42, 7);

describe('recordCompanyVisit', () => {
  test('a visit to an existing page is one row, keyed on the UTC hour', async () => {
    const { store, inserts } = fakeStore(['acme-ltd']);
    expect(await recordCompanyVisit('s1', 'acme-ltd', store, NOW)).toBe(true);
    expect(inserts).toEqual([
      { sessionId: 's1', slug: 'acme-ltd', hour: hourBucket(NOW) },
    ]);
  });

  test('a well-formed slug that names no company page is not a visit', async () => {
    const { store, lookups, inserts } = fakeStore(['acme-ltd']);
    expect(await recordCompanyVisit('s1', 'no-such-company', store, NOW)).toBe(
      false,
    );
    expect(lookups).toEqual(['no-such-company']);
    expect(inserts).toEqual([]);
  });

  test('input is normalised to the canonical slug before the lookup', async () => {
    const { store, lookups, inserts } = fakeStore(['acme-ltd']);
    expect(await recordCompanyVisit('s1', 'Acme Ltd', store, NOW)).toBe(true);
    expect(lookups).toEqual(['acme-ltd']);
    expect(inserts.map((r) => r.slug)).toEqual(['acme-ltd']);
  });

  test('malformed input never reaches the database', async () => {
    const { store, lookups, inserts } = fakeStore(['acme-ltd']);
    for (const bad of [42, undefined, '', 'a'.repeat(256)])
      expect(await recordCompanyVisit('s1', bad, store, NOW)).toBe(false);
    expect(lookups).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('a failing store is a quiet false, never a throw', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { store } = fakeStore(['acme-ltd'], { insertFails: true });
      expect(await recordCompanyVisit('s1', 'acme-ltd', store, NOW)).toBe(
        false,
      );
      expect(quiet).toHaveBeenCalledTimes(1);
    } finally {
      quiet.mockRestore();
    }
  });
});
