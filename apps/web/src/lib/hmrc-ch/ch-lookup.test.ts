import { describe, expect, test } from 'bun:test';

import {
  type ChResponse,
  fetchChApi,
  fetchMappedProfile,
  isTransientChFailure,
} from './ch-lookup';

const ok = (data: unknown): ChResponse => ({ ok: true, data });
const failed = (status: number): ChResponse => ({ ok: false, status });

/** Ordered route table: first prefix match wins; unmatched paths answer 404. */
function makeChFetch(routes: [string, ChResponse][]) {
  const fetchCh = async (path: string): Promise<ChResponse> => {
    for (const [prefix, response] of routes) {
      if (path.startsWith(prefix)) return response;
    }
    return failed(404);
  };
  return { fetchCh };
}

const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('isTransientChFailure', () => {
  test('a 404 is Companies House saying the company does not exist', () => {
    expect(isTransientChFailure(404)).toBe(false);
  });

  test('a rate limit says nothing about the company', () => {
    // The case this guards: a sponsor new to the register, first rendered
    // while the shared API key is rate-limited, must not read as "no record".
    expect(isTransientChFailure(429)).toBe(true);
  });

  test.each([500, 502, 503, 504, 401, 410])('a %i says nothing either', (s) => {
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
      cause: 'fetch failed',
    });
  });

  test('an unreadable 2xx body is a transport failure', async () => {
    const fetchImpl = (async () =>
      json('<html>gateway</html>')) as unknown as typeof fetch;
    const res = await fetchChApi('/company/00000871', 'k', { fetchImpl });
    expect(res).toMatchObject({ ok: false, status: 0 });
    expect(res.ok ? '' : res.cause).toContain('JSON');
  });

  test('a call that never answers times out as a transport failure', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      })) as unknown as typeof fetch;
    const res = await fetchChApi('/company/00000871', 'k', {
      fetchImpl,
      timeoutMs: 10,
    });
    expect(res).toMatchObject({ ok: false, status: 0 });
    expect(res.ok ? '' : res.cause).toContain('timed out');
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
