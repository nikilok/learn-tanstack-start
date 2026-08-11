import { describe, expect, test } from 'bun:test';

import { geocodeUpstream } from './geocode-upstream';

const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('geocodeUpstream', () => {
  test('resolves coords from a well-formed body', async () => {
    const fetchImpl = (async () =>
      json('[{"lat":"51.5074","lon":"-0.1278"}]')) as unknown as typeof fetch;
    expect(await geocodeUpstream('SW1A 1AA', { fetchImpl })).toEqual({
      ok: true,
      geo: { lat: 51.5074, lon: -0.1278 },
    });
  });

  test('an empty result set is an upstream success with null geo', async () => {
    const fetchImpl = (async () => json('[]')) as unknown as typeof fetch;
    expect(await geocodeUpstream('ZZ99 9ZZ', { fetchImpl })).toEqual({
      ok: true,
      geo: null,
    });
  });

  test('a rejected fetch fails without throwing', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const result = await geocodeUpstream('SW1A 1AA', { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'request error: TypeError' });
  });

  test('a non-OK status fails with the status in the reason', async () => {
    const fetchImpl = (async () => json('', 429)) as unknown as typeof fetch;
    expect(await geocodeUpstream('SW1A 1AA', { fetchImpl })).toEqual({
      ok: false,
      reason: 'status 429',
    });
  });

  test('an unparseable body fails without throwing', async () => {
    const fetchImpl = (async () =>
      json('<html>challenge</html>')) as unknown as typeof fetch;
    const result = await geocodeUpstream('SW1A 1AA', { fetchImpl });
    expect(result.ok).toBe(false);
  });

  test('a valid-JSON non-array body fails', async () => {
    const fetchImpl = (async () =>
      json('{"error":"blocked"}')) as unknown as typeof fetch;
    expect(await geocodeUpstream('SW1A 1AA', { fetchImpl })).toEqual({
      ok: false,
      reason: 'non-array body',
    });
  });

  test('a stalled request aborts at the timeout instead of hanging', async () => {
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const result = await geocodeUpstream('SW1A 1AA', {
      fetchImpl,
      timeoutMs: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'request error: AbortError' });
  });

  test('a stalled body read aborts at the same timeout', async () => {
    // Headers arrive fine; json() never settles until the signal aborts — the timeout must span the body read too.
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              ),
            );
          }),
      })) as unknown as typeof fetch;
    const result = await geocodeUpstream('SW1A 1AA', {
      fetchImpl,
      timeoutMs: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'request error: AbortError' });
  });
});
