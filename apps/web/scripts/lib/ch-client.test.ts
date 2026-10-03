import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';

import { makeScriptChFetch, toFetchOutcome } from './ch-client.ts';

describe('toFetchOutcome', () => {
  test('a 2xx keeps its data', () => {
    expect(toFetchOutcome({ ok: true, data: { company_number: '1' } })).toEqual(
      { ok: true, data: { company_number: '1' } },
    );
  });

  test.each([404, 410])('a %i is not found', (status) => {
    expect(toFetchOutcome({ ok: false, status })).toEqual({
      ok: false,
      notFound: true,
    });
  });

  test.each([0, 401, 429, 503])(
    'a %i is an error, never not found',
    (status) => {
      expect(toFetchOutcome({ ok: false, status })).toEqual({
        ok: false,
        notFound: false,
      });
    },
  );
});

describe('makeScriptChFetch', () => {
  const KEY = 'COMPANIES_HOUSE_SEED_API_KEY';
  const saved = process.env[KEY];
  let errorLog: ReturnType<typeof spyOn>;
  let log: ReturnType<typeof spyOn>;

  /** A fetch that answers every call with `status`, plus the pauses the retries took. */
  function answering(status: number) {
    const fetchImpl = mock(async () => new Response('', { status }));
    const pauses: number[] = [];
    const fetchCh = makeScriptChFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    return { fetchCh, fetchImpl, pauses };
  }

  beforeEach(() => {
    process.env[KEY] = 'test-key';
    errorLog = spyOn(console, 'error').mockImplementation(() => {});
    log = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    errorLog.mockRestore();
    log.mockRestore();
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test('a missing key fails fast instead of retrying as a transport failure', async () => {
    delete process.env[KEY];
    const { fetchCh, fetchImpl, pauses } = answering(200);
    await expect(fetchCh('/company/00000871')).rejects.toThrow(
      `${KEY} not set`,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pauses).toHaveLength(0);
  });

  test('a 503 is retried three times, a minute apart, then keeps its status', async () => {
    const { fetchCh, fetchImpl, pauses } = answering(503);
    expect(await fetchCh('/company/00000871')).toEqual({
      ok: false,
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(pauses).toEqual([60_000, 60_000, 60_000]);
  });

  test('a 404 comes back as itself, unretried', async () => {
    const { fetchCh, fetchImpl } = answering(404);
    expect(await fetchCh('/company/00000871')).toEqual({
      ok: false,
      status: 404,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a 410 keeps its status for the resolver and reads as not found for the backfills', async () => {
    const { fetchCh } = answering(410);
    const res = await fetchCh('/company/00000871');
    expect(res).toEqual({ ok: false, status: 410 });
    expect(toFetchOutcome(res)).toEqual({ ok: false, notFound: true });
  });
});
