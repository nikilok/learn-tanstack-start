import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { rendersListing } from './listing.server';
import { parseRanges } from './ranges';

const ranges = parseRanges(['66.249.64.0/27']);
const crawler = '66.249.64.10';
const visitor = '81.2.69.160';

/** A home page request with a search term, from `ip`, its URL carrying `query` as well. */
function request(ip: string | null, query = '') {
  const headers = new Headers();
  if (ip) headers.set('x-real-ip', ip);
  return { url: `https://example.test/?search=acme${query}`, headers };
}

const enforced = {
  mode: 'enforce' as const,
  ranges: async () => ranges,
  owner: async () => false,
};

describe('rendersListing', () => {
  test('under enforce, a visitor is sent no results: they load through the session', async () => {
    expect(await rendersListing(request(visitor), enforced)).toBe(false);
  });

  test('under enforce, a crawler and the owner get the results in the document', async () => {
    expect(await rendersListing(request(crawler), enforced)).toBe(true);
    expect(
      await rendersListing(request(visitor), {
        ...enforced,
        owner: async () => true,
      }),
    ).toBe(true);
  });

  test('anything that cannot be decided renders them, as a company page does', async () => {
    expect(
      await rendersListing(request(visitor), {
        ...enforced,
        ranges: async () => null,
      }),
    ).toBe(true);
    expect(await rendersListing(request(null), enforced)).toBe(true);
  });

  test.each([
    ['observe', 'observe' as const],
    ['off', null],
  ])('under %s, everyone gets them', async (_, mode) => {
    expect(await rendersListing(request(visitor), { ...enforced, mode })).toBe(
      true,
    );
  });

  test("the shell mark shows a visitor's page to anyone, in every mode", async () => {
    for (const mode of ['enforce', 'observe', null] as const)
      expect(
        await rendersListing(request(crawler, '&render=client'), {
          ...enforced,
          mode,
          owner: async () => true,
        }),
      ).toBe(false);
  });

  // Which search starts, and that none does unless asked, is `startListing`'s, tested on its own
  // (`lib/search/listing-prefetch.test.ts`): the loader must hand it this gate, and start nothing
  // but through it.
  test('the home loader starts its searches through startListing, gated by it', () => {
    const loader = readFileSync(
      join(import.meta.dir, '../../routes/index.tsx'),
      'utf8',
    );
    expect(loader).toContain('rendered: listingRenderedHere,');
    const start = loader.indexOf('start: (listing) =>');
    expect(start).toBeGreaterThan(-1);
    const prefetches = [...loader.matchAll(/prefetchInfiniteQuery\(/g)];
    expect(prefetches).toHaveLength(2);
    for (const prefetch of prefetches)
      expect(prefetch.index).toBeGreaterThan(start);
  });
});
