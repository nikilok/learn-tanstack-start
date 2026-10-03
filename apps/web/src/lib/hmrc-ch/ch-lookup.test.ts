import { describe, expect, test } from 'bun:test';

import {
  type ChResponse,
  fetchChApi,
  fetchMappedProfile,
  isTransientChFailure,
  resolveWithoutGaps,
} from './ch-lookup';
import { resolveOneSponsor } from './resolve-sponsor';

const ok = (data: unknown): ChResponse => ({ ok: true, data });
const failed = (status: number): ChResponse => ({ ok: false, status });

/** Ordered route table: first prefix match wins; unmatched paths answer 404. */
function makeChFetch(routes: [string, ChResponse][]) {
  const calls: string[] = [];
  const fetchCh = async (path: string): Promise<ChResponse> => {
    calls.push(path);
    for (const [prefix, response] of routes) {
      if (path.startsWith(prefix)) return response;
    }
    return failed(404);
  };
  return { fetchCh, calls };
}

const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const noLocation = { townCity: null, county: null };

describe('isTransientChFailure', () => {
  test('a 404 is Companies House saying the company does not exist', () => {
    expect(isTransientChFailure(404)).toBe(false);
  });

  test('a rate limit says nothing about the company', () => {
    // The case this guards: a sponsor new to the register, first rendered
    // while the shared API key is rate-limited, must not read as "no record".
    expect(isTransientChFailure(429)).toBe(true);
  });

  test.each([500, 502, 503, 504, 401])('a %i says nothing either', (s) => {
    expect(isTransientChFailure(s)).toBe(true);
  });

  test('a transport failure (status 0) says nothing either', () => {
    expect(isTransientChFailure(0)).toBe(true);
  });
});

describe('fetchChApi', () => {
  test('returns the parsed body of a 2xx', async () => {
    const fetchImpl = (async () =>
      json('{"company_number":"00000871"}')) as unknown as typeof fetch;
    expect(await fetchChApi('/company/00000871', 'k', { fetchImpl })).toEqual({
      ok: true,
      data: { company_number: '00000871' },
    });
  });

  test('reports a non-2xx as its status', async () => {
    const fetchImpl = (async () => json('', 429)) as unknown as typeof fetch;
    expect(await fetchChApi('/company/00000871', 'k', { fetchImpl })).toEqual({
      ok: false,
      status: 429,
    });
  });

  test('a rejected fetch is a transport failure, not a throw', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchChApi('/company/00000871', 'k', { fetchImpl })).toEqual({
      ok: false,
      status: 0,
    });
  });

  test('an unreadable 2xx body is a transport failure', async () => {
    const fetchImpl = (async () =>
      json('<html>gateway</html>')) as unknown as typeof fetch;
    expect(await fetchChApi('/company/00000871', 'k', { fetchImpl })).toEqual({
      ok: false,
      status: 0,
    });
  });

  test('a call that never answers times out as a transport failure', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      })) as unknown as typeof fetch;
    expect(
      await fetchChApi('/company/00000871', 'k', { fetchImpl, timeoutMs: 10 }),
    ).toEqual({ ok: false, status: 0 });
  });

  test('authenticates with the key as the Basic username', async () => {
    const seen: { auth: string | null } = { auth: null };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.auth = new Headers(init?.headers).get('Authorization');
      return json('{}');
    }) as unknown as typeof fetch;
    await fetchChApi('/company/00000871', 'test-key', { fetchImpl });
    expect(seen.auth).toBe(`Basic ${btoa('test-key:')}`);
  });
});

describe('fetchMappedProfile', () => {
  test('a mapped company with no stored profile is unavailable on a 503', async () => {
    const { fetchCh } = makeChFetch([['/company/00000871', failed(503)]]);
    expect(await fetchMappedProfile('00000871', fetchCh)).toEqual({
      verdict: 'unavailable',
    });
  });

  test('a transport failure is unavailable too', async () => {
    const { fetchCh } = makeChFetch([['/company/00000871', failed(0)]]);
    expect(await fetchMappedProfile('00000871', fetchCh)).toEqual({
      verdict: 'unavailable',
    });
  });

  test('a 404 is a verified absence', async () => {
    const { fetchCh } = makeChFetch([]);
    expect(await fetchMappedProfile('00000871', fetchCh)).toEqual({
      verdict: 'absent',
    });
  });

  test('a 2xx is the profile', async () => {
    const profile = { company_number: '00000871' };
    const { fetchCh } = makeChFetch([['/company/00000871', ok(profile)]]);
    expect(await fetchMappedProfile('00000871', fetchCh)).toEqual({
      verdict: 'found',
      profile,
    });
  });
});

describe('resolveWithoutGaps', () => {
  // resolve-sponsor's own example: HMRC lists 3DC LTD; search returns the
  // dissolved exact namesake and the active company renamed from 3DC LTD.
  const items = [
    {
      company_number: '00000003',
      title: '3DC LIMITED',
      company_status: 'dissolved',
    },
    {
      company_number: '00000004',
      title: 'SHOP3D LTD',
      company_status: 'active',
    },
  ];
  const dissolved = {
    company_number: '00000003',
    company_name: '3DC LIMITED',
    company_status: 'dissolved',
  };
  const renamed = {
    company_number: '00000004',
    company_name: 'SHOP3D LTD',
    company_status: 'active',
    previous_company_names: [{ name: '3DC LTD' }],
  };

  test('a 429 on the renamed company never lets the dissolved namesake verify', async () => {
    const { fetchCh } = makeChFetch([
      ['/search/companies', ok({ items })],
      ['/company/00000003', ok(dissolved)],
      ['/company/00000004', failed(429)],
    ]);
    // Reading the lost probe as "not found", the bare resolver falls back to
    // the dissolved match and calls it verified: a mapping kept for good.
    const bare = await resolveOneSponsor('3DC LTD', noLocation, async (p) => {
      const res = await fetchCh(p);
      return res.ok ? res.data : null;
    });
    expect(bare).toMatchObject({
      verdict: 'verified',
      companyNumber: '00000003',
    });

    expect(await resolveWithoutGaps('3DC LTD', noLocation, fetchCh)).toEqual({
      verdict: 'unavailable',
    });
  });

  test('with every answer in, the renamed company verifies by its previous name', async () => {
    const { fetchCh } = makeChFetch([
      ['/search/companies', ok({ items })],
      ['/company/00000003', ok(dissolved)],
      ['/company/00000004', ok(renamed)],
    ]);
    expect(
      await resolveWithoutGaps('3DC LTD', noLocation, fetchCh),
    ).toMatchObject({
      verdict: 'verified',
      companyNumber: '00000004',
      matchMethod: 'previous_name',
    });
  });

  test('stops at the first transient failure', async () => {
    const { fetchCh, calls } = makeChFetch([
      ['/search/companies', failed(503)],
    ]);
    expect(
      await resolveWithoutGaps('ACME TRADING LTD', noLocation, fetchCh),
    ).toEqual({ verdict: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  test('an empty search is still a definitive no_match', async () => {
    const { fetchCh } = makeChFetch([['/search/companies', ok({ items: [] })]]);
    expect(
      await resolveWithoutGaps('ACME TRADING LTD', noLocation, fetchCh),
    ).toMatchObject({ verdict: 'no_match' });
  });

  test('a 404 on a probe is evidence, not a gap', async () => {
    const { fetchCh } = makeChFetch([
      ['/search/companies', ok({ items: [items[1]] })],
    ]);
    expect(
      await resolveWithoutGaps('3DC LTD', noLocation, fetchCh),
    ).toMatchObject({ verdict: 'no_match' });
  });
});
