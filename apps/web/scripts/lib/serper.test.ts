import { afterEach, describe, expect, test } from 'bun:test';

import { searchCompany } from './serper.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the one request this module makes, capturing what it sent. */
function stub(
  response: Partial<Response> & { jsonBody?: unknown; textBody?: string },
) {
  const sent: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => {
        if ('jsonBody' in response) return response.jsonBody;
        throw new SyntaxError('Unexpected end of JSON input');
      },
      text: async () => response.textBody ?? '',
    } as Response;
  }) as typeof fetch;
  return sent;
}

describe('searchCompany — the request', () => {
  test('asks for ten results and UK localisation', async () => {
    // Both are cost and correctness decisions, not defaults. One credit covers
    // up to ten results and eleven costs two, so `num` above ten silently
    // doubles the price of a 109k pass. And every company here is
    // UK-registered: an unlocalised query spends its top results on the
    // American namesake.
    const sent = stub({ jsonBody: { organic: [] } });
    await searchCompany('ACME CARE Leeds', 'key');
    const body = JSON.parse(sent[0].init.body as string);
    expect(body.num).toBe(10);
    expect(body.gl).toBe('gb');
    expect(body.q).toBe('ACME CARE Leeds');
    expect((sent[0].init.headers as Record<string, string>)['X-API-KEY']).toBe(
      'key',
    );
  });

  test('returns organic links in rank order, dropping blanks', async () => {
    stub({
      jsonBody: {
        organic: [
          { link: 'https://a.co.uk' },
          { title: 'no link here' },
          { link: 'https://b.co.uk' },
        ],
      },
    });
    const result = await searchCompany('q', 'key');
    expect(result).toEqual({
      ok: true,
      urls: ['https://a.co.uk', 'https://b.co.uk'],
    });
  });
});

describe('searchCompany — failures are distinguished, not collapsed', () => {
  test('402 is an exhausted balance, which must stop the whole run', async () => {
    // Read as a generic http error it would burn ten more rows on the failure
    // streak first, each one a query that could never have succeeded.
    stub({ ok: false, status: 402 });
    expect(await searchCompany('q', 'key')).toEqual({
      ok: false,
      reason: 'out_of_credits',
      status: 402,
    });
  });

  test('403 is read from the body, since it covers two different things', async () => {
    stub({ ok: false, status: 403, textBody: 'insufficient credit balance' });
    expect((await searchCompany('q', 'key')).ok).toBe(false);
    expect(await searchCompany('q', 'key')).toMatchObject({
      reason: 'out_of_credits',
    });

    stub({ ok: false, status: 403, textBody: 'forbidden' });
    expect(await searchCompany('q', 'key')).toMatchObject({ reason: 'auth' });
  });

  test('401 is a bad key and 429 is backpressure', async () => {
    stub({ ok: false, status: 401 });
    expect(await searchCompany('q', 'key')).toMatchObject({ reason: 'auth' });
    stub({ ok: false, status: 429 });
    expect(await searchCompany('q', 'key')).toMatchObject({
      reason: 'rate_limit',
    });
  });

  test('an unparsable 200 is a FAILURE, not an empty result set', async () => {
    // The damaging one. Read as "no results" it banks an empty candidate list
    // and writes a permanent `none` for a company that was never searched —
    // a credit spent on a wrong answer nothing would revisit.
    stub({ ok: true, status: 200 });
    const result = await searchCompany('q', 'key');
    expect(result.ok).toBe(false);
    expect(result).not.toMatchObject({ urls: [] });
  });

  test('a 200 with no organic array is a failure for the same reason', async () => {
    stub({ ok: true, status: 200, jsonBody: { message: 'something else' } });
    expect((await searchCompany('q', 'key')).ok).toBe(false);
  });

  test('a 200 with an EMPTY organic array is a real "no results"', async () => {
    // The distinction that matters: the provider answered and found nothing,
    // which is a legitimate answer worth banking.
    stub({ ok: true, status: 200, jsonBody: { organic: [] } });
    expect(await searchCompany('q', 'key')).toEqual({ ok: true, urls: [] });
  });

  test('a thrown request is network, not a silent empty result', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await searchCompany('q', 'key')).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('searchCompany — zero results is an answer, not an error', () => {
  test('a 200 with no organic key banks an empty result set', async () => {
    // Serper omits `organic` entirely when a query returns nothing organic.
    // Treating that as a failure meant the company was never banked and so was
    // re-searched and re-charged on every future run, forever — a regression
    // introduced by the fix for unparsable bodies.
    stub({
      ok: true,
      status: 200,
      jsonBody: { searchParameters: {}, credits: 1 },
    });
    expect(await searchCompany('q', 'key')).toEqual({ ok: true, urls: [] });
  });

  test('a 200 carrying an error message is still a failure', async () => {
    stub({
      ok: true,
      status: 200,
      jsonBody: { message: 'Not enough credits' },
    });
    expect((await searchCompany('q', 'key')).ok).toBe(false);
  });
});

describe('searchCompany — a bare array body is not a result set', () => {
  test('an array 200 is a failure, since typeof [] is "object"', async () => {
    // It would otherwise slip past the object guard, read undefined for
    // `organic`, and bank an empty candidate list for a company that was
    // never really searched.
    stub({ ok: true, status: 200, jsonBody: [] });
    expect((await searchCompany('q', 'key')).ok).toBe(false);
  });
});

describe('searchCompany — an error message alongside organic is still an error', () => {
  test.each([
    ['organic null', { message: 'Not enough credits', organic: null }],
    ['organic empty', { message: 'Not enough credits', organic: [] }],
    ['organic wrong type', { message: 'boom', organic: 'oops' }],
  ])('%s is a failure, not zero results', async (_label, jsonBody) => {
    // The guard used to require `organic` to be entirely ABSENT, so an errored
    // 200 carrying the key in any form was banked as a legitimate empty
    // answer and wrote a permanent `none` for a company never searched.
    stub({ ok: true, status: 200, jsonBody });
    expect((await searchCompany('q', 'key')).ok).toBe(false);
  });

  test('a malformed 200 reports that it was charged', async () => {
    // Any 200 is billed, so reporting it as unspent understates credits_spent
    // against the invoice and re-charges the company next run.
    stub({ ok: true, status: 200 });
    expect(await searchCompany('q', 'key')).toMatchObject({ charged: true });
  });

  test('a pre-200 failure is not charged', async () => {
    stub({ ok: false, status: 401 });
    expect(
      (await searchCompany('q', 'key')) as { charged?: boolean },
    ).not.toMatchObject({
      charged: true,
    });
  });
});

describe('searchCompany — organic entries are validated, not counted', () => {
  test('an error message beside link-less entries is still a failure', async () => {
    // organic.length was the gate, but [{}] is length 1 and yields no usable
    // URL — so this banked as zero results and wrote a permanent `none`.
    stub({
      ok: true,
      status: 200,
      jsonBody: { message: 'Not enough credits', organic: [{}] },
    });
    expect(await searchCompany('q', 'key')).toMatchObject({
      ok: false,
      reason: 'malformed',
      charged: true,
    });
  });

  test('a null entry does not throw out of the client', async () => {
    // `r.link` on null threw a TypeError that escaped searchCompany entirely,
    // bypassing every charged-credit path the caller relies on.
    stub({ ok: true, status: 200, jsonBody: { organic: [null] } });
    expect(await searchCompany('q', 'key')).toEqual({ ok: true, urls: [] });
  });

  test('usable links survive alongside unusable entries', async () => {
    stub({
      ok: true,
      status: 200,
      jsonBody: { organic: [null, {}, { link: 'https://real.co.uk' }] },
    });
    expect(await searchCompany('q', 'key')).toEqual({
      ok: true,
      urls: ['https://real.co.uk'],
    });
  });
});
