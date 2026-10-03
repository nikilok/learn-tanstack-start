import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import type { ChResponse } from './ch-lookup';
import { isRetryableChFailure, withChRetries } from './ch-retry';

const ok = (data: unknown): ChResponse => ({ ok: true, data });
const failed = (status: number): ChResponse => ({ ok: false, status });

/** A fetch that answers each call with the next canned response, recording calls and pauses. */
function scripted(...answers: ChResponse[]) {
  const calls: string[] = [];
  const pauses: number[] = [];
  const fetchCh = withChRetries(
    async (path) => {
      calls.push(path);
      return answers[Math.min(calls.length, answers.length) - 1];
    },
    {
      retries: 3,
      pauseMs: 60_000,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    },
  );
  return { fetchCh, calls, pauses };
}

let log: ReturnType<typeof spyOn>;
let errorLog: ReturnType<typeof spyOn>;
beforeEach(() => {
  log = spyOn(console, 'log').mockImplementation(() => {});
  errorLog = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  errorLog.mockRestore();
});

describe('isRetryableChFailure', () => {
  test.each([0, 429, 500, 502, 503, 504])('retries a %i', (status) => {
    expect(isRetryableChFailure(status)).toBe(true);
  });

  test.each([400, 401, 403, 404, 410])('does not retry a %i', (status) => {
    expect(isRetryableChFailure(status)).toBe(false);
  });
});

describe('withChRetries', () => {
  test('a 5xx burst during a Companies House deploy is retried until it answers', async () => {
    const { fetchCh, calls, pauses } = scripted(
      failed(503),
      failed(502),
      ok({ items: [] }),
    );
    expect(await fetchCh('/search/companies?q=ACME')).toEqual(
      ok({ items: [] }),
    );
    expect(calls).toHaveLength(3);
    expect(pauses).toEqual([60_000, 60_000]);
  });

  test('gives up after its retries and reports the status, so the resolver sees a gap', async () => {
    const { fetchCh, calls } = scripted(failed(429));
    expect(await fetchCh('/company/00000004')).toEqual(failed(429));
    expect(calls).toHaveLength(4);
    expect(String(errorLog.mock.calls[0]?.[0])).toContain(
      'Rate limited retries exhausted for /company/00000004',
    );
  });

  test('a transport failure is retried too', async () => {
    const { fetchCh, calls } = scripted(failed(0), ok({}));
    expect(await fetchCh('/company/00000004')).toEqual(ok({}));
    expect(calls).toHaveLength(2);
  });

  test('giving up on a transport failure logs its cause', async () => {
    const timedOut: ChResponse = {
      ok: false,
      status: 0,
      cause: 'The operation timed out.',
    };
    const { fetchCh } = scripted(timedOut);
    expect(await fetchCh('/company/00000004')).toEqual(timedOut);
    expect(String(errorLog.mock.calls[0]?.[0])).toContain(
      'Transport failure (The operation timed out.) retries exhausted for /company/00000004',
    );
  });

  test('a 404 is an answer: no retry, no log', async () => {
    const { fetchCh, calls, pauses } = scripted(failed(404));
    expect(await fetchCh('/company/00000004')).toEqual(failed(404));
    expect(calls).toHaveLength(1);
    expect(pauses).toHaveLength(0);
    expect(errorLog).not.toHaveBeenCalled();
  });

  test('an auth failure returns at once and is logged', async () => {
    const { fetchCh, calls, pauses } = scripted(failed(401));
    expect(await fetchCh('/company/00000004')).toEqual(failed(401));
    expect(calls).toHaveLength(1);
    expect(pauses).toHaveLength(0);
    expect(String(errorLog.mock.calls[0]?.[0])).toContain(
      'Unexpected 401 for /company/00000004',
    );
  });
});
