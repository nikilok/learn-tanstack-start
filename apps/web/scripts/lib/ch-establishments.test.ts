import { describe, expect, test } from 'bun:test';

import type { ChResponse } from '../../src/lib/hmrc-ch/ch-lookup.ts';
import { ChStatus, makeEstablishmentReads } from './ch-establishments.ts';

/** The reads over one canned response, recording the paths asked. */
function readsWith(res: ChResponse) {
  const paths: string[] = [];
  const reads = makeEstablishmentReads(async (path) => {
    paths.push(path);
    return res;
  });
  return { reads, paths };
}

describe('makeEstablishmentReads', () => {
  test("JPMorgan Chase Bank: the establishments listed under FC004891, by the company's own path", async () => {
    const items = [{ company_number: 'BR000746', company_status: 'open' }];
    const { reads, paths } = readsWith({
      ok: true,
      data: { kind: 'related-companies', items },
    });
    expect(await reads.fetchEstablishments('FC004891')).toEqual(items);
    expect(paths).toEqual(['/company/FC004891/uk-establishments']);
  });

  // Dennison Trailers (FC021303) answers with an empty list; a 404 says the same.
  test.each([
    ['an empty list', { ok: true, data: { items: [] } }],
    ['no list at all', { ok: true, data: {} }],
    ['a list that is no array', { ok: true, data: { items: 'none' } }],
    ['a 404', { ok: false, status: 404 }],
  ] as [string, ChResponse][])(
    '%s is no establishment listed',
    async (_label, res) => {
      expect(
        await readsWith(res).reads.fetchEstablishments('FC021303'),
      ).toEqual([]);
    },
  );

  test.each([[0], [401], [429], [502]])(
    'a list that cannot be read (%d) is a throw named by its status, never none listed',
    async (status) => {
      const { reads } = readsWith({ ok: false, status });
      const failure = reads.fetchEstablishments('FC004891');
      await expect(failure).rejects.toBeInstanceOf(ChStatus);
      await expect(failure).rejects.toMatchObject({ name: `HTTP ${status}` });
    },
  );

  test("a company's profile, null for a 404, and a throw when it cannot be read", async () => {
    const profile = {
      company_number: 'BR000746',
      company_name: 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION',
      company_status: 'open',
    };
    const found = readsWith({ ok: true, data: profile });
    expect(await found.reads.fetchProfile('BR000746')).toEqual(profile);
    expect(found.paths).toEqual(['/company/BR000746']);
    expect(
      await readsWith({ ok: false, status: 404 }).reads.fetchProfile(
        'BR000746',
      ),
    ).toBeNull();
    await expect(
      readsWith({ ok: false, status: 503 }).reads.fetchProfile('BR000746'),
    ).rejects.toMatchObject({ name: 'HTTP 503' });
  });

  test('a number is escaped into the path it is asked by', async () => {
    const { reads, paths } = readsWith({ ok: false, status: 404 });
    await reads.fetchEstablishments('FC 1/2');
    await reads.fetchProfile('FC 1/2');
    expect(paths).toEqual([
      '/company/FC%201%2F2/uk-establishments',
      '/company/FC%201%2F2',
    ]);
  });
});
