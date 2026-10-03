import { describe, expect, test } from 'bun:test';

import { ROUTE_RULES } from '../../route-rules';
import {
  blockedTileResponse,
  uncachedTileError,
  upstreamTileResponse,
} from './tileResponses';

const ALLOWED_REFERERS = [
  'https://sponsorsearch.co.uk/company/acme-ltd',
  'https://www.sponsorsearch.co.uk/',
  'https://learn-tanstack-start-a1b2c3-nikil-kuruvillas-projects.vercel.app/company/acme-ltd',
];
const REFUSED_REFERERS = [
  null,
  '',
  'not a url',
  'http://sponsorsearch.co.uk/',
  'https://example.com/',
  'https://notsponsorsearch.co.uk/',
  'https://sponsorsearch.co.uk.example.com/',
  'https://other-app-nikil-kuruvillas-projects.vercel.app/',
  'https://learn-tanstack-start-a1b2c3.vercel.app/',
  'https://learn-tanstack-start-a1b2c3-nikil-kuruvillas-projects.vercel.app.example.com/',
];
const REFERERS = [...ALLOWED_REFERERS, ...REFUSED_REFERERS];

const OFF_ORIGIN = [null, 'cross-site', 'same-site', 'none'];
const NON_CANONICAL = [
  'Same-Origin',
  'same-origin, same-origin',
  'same-origin, cross-site',
  'cross-site, same-origin',
  '',
  'unknown',
];
const FETCH_SITES = ['same-origin', ...OFF_ORIGIN, ...NON_CANONICAL];

const REFUSAL = {
  status: 302,
  location: '/blocked-tile.png',
  vary: 'Sec-Fetch-Site',
};
const NO_STORE = 'private, no-store';
const TILE_PATH = '/api/tiles/alidade_smooth/10/511/340@2x';

// Vercel's cacheable statuses.
const EDGE_CACHEABLE_STATUSES = new Set([200, 301, 302, 307, 308, 404, 410]);

/** Request headers for a tile fetch; null leaves a header out. */
function requestHeaders(
  fetchSite: string | null,
  referer: string | null,
): Headers {
  const headers = new Headers();
  if (fetchSite !== null) headers.set('sec-fetch-site', fetchSite);
  if (referer !== null) headers.set('referer', referer);
  return headers;
}

/** The parts of a tile response its caching depends on; null when the request is served. */
function outcome(res: Response | null) {
  return (
    res && {
      status: res.status,
      location: res.headers.get('location'),
      vary: res.headers.get('vary'),
      cacheControl: res.headers.get('cache-control'),
    }
  );
}

/** Each Sec-Fetch-Site and Referer pair with the access check's answer, labelled so a failing case names itself. */
function answers(
  fetchSites: (string | null)[],
  referers: (string | null)[],
  checkReferer = true,
) {
  return fetchSites.flatMap((fetchSite) =>
    referers.map((referer) => ({
      fetchSite,
      referer,
      answer: outcome(
        blockedTileResponse(requestHeaders(fetchSite, referer), checkReferer),
      ),
    })),
  );
}

/** Asserts every pair got `answer`; the diff lists only the pairs that did not. */
function expectAll(
  got: ReturnType<typeof answers>,
  answer: ReturnType<typeof outcome>,
): void {
  expect(got).toEqual(got.map((pair) => ({ ...pair, answer })));
}

/** Whether Vercel's edge may cache the response under the tile route rule: a 2xx always (h3 merges the rule over it), anything else unless its own Cache-Control is private, no-store or no-cache. */
function edgeCacheable(res: Response): boolean {
  if (!EDGE_CACHEABLE_STATUSES.has(res.status)) return false;
  if (res.ok) return true;
  return !/\b(private|no-store|no-cache)\b/.test(
    res.headers.get('cache-control') ?? '',
  );
}

/** Whether a route rule pattern reaches the tile path. */
function reachesTiles(pattern: string): boolean {
  return pattern.endsWith('/**')
    ? TILE_PATH.startsWith(pattern.slice(0, -2))
    : pattern === TILE_PATH;
}

describe('blockedTileResponse', () => {
  test('serves a same-origin request from the site or one of its deployments', () => {
    expectAll(answers(['same-origin'], ALLOWED_REFERERS), null);
  });

  test('refuses a same-origin request without an allowed Referer, uncached', () => {
    expectAll(answers(['same-origin'], REFUSED_REFERERS), {
      ...REFUSAL,
      cacheControl: NO_STORE,
    });
  });

  test('refuses an off-origin request whatever its Referer, leaving the refusal cacheable', () => {
    expectAll(answers(OFF_ORIGIN, REFERERS), {
      ...REFUSAL,
      cacheControl: null,
    });
  });

  test('refuses any other Sec-Fetch-Site value uncached', () => {
    expectAll(answers(NON_CANONICAL, REFERERS), {
      ...REFUSAL,
      cacheControl: NO_STORE,
    });
  });

  test('a refusal is edge-cacheable only for an off-origin value, and then for every Referer', () => {
    const unsafe = FETCH_SITES.filter((fetchSite) => {
      const outcomes = REFERERS.map((referer) =>
        blockedTileResponse(requestHeaders(fetchSite, referer), true),
      );
      const cacheable = outcomes.some(
        (res) => res !== null && edgeCacheable(res),
      );
      return (
        cacheable &&
        (!OFF_ORIGIN.includes(fetchSite) ||
          outcomes.some((res) => res === null))
      );
    });
    expect(unsafe).toEqual([]);
  });

  test('skips the Referer check outside production', () => {
    expectAll(answers(['same-origin'], REFERERS, false), null);
    expectAll(answers(OFF_ORIGIN, [null], false), {
      ...REFUSAL,
      cacheControl: null,
    });
  });
});

describe('upstreamTileResponse', () => {
  test('serves an upstream tile as a PNG partitioned by Sec-Fetch-Site', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const res = await upstreamTileResponse(
      new Response(png, { headers: { 'Content-Type': 'image/png' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('vary')).toBe('Sec-Fetch-Site');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  test('passes an upstream error status on with no body, uncached, including a 404 or 410', async () => {
    for (const status of [404, 410, 401, 429, 500, 503]) {
      const res = await upstreamTileResponse(
        new Response('upstream error', { status }),
      );
      expect(outcome(res)).toEqual({
        status,
        location: null,
        vary: null,
        cacheControl: NO_STORE,
      });
      expect(edgeCacheable(res)).toBe(false);
      expect(await res.text()).toBe('');
    }
  });
});

describe('uncachedTileError', () => {
  test('answers with no body, uncached', async () => {
    for (const status of [500, 502]) {
      const res = uncachedTileError(status);
      expect(outcome(res)).toEqual({
        status,
        location: null,
        vary: null,
        cacheControl: NO_STORE,
      });
      expect(edgeCacheable(res)).toBe(false);
      expect(await res.text()).toBe('');
    }
  });
});

describe('route rules reaching a tile', () => {
  test('the tile rule caches through Cache-Control alone, which a non-2xx response replaces', () => {
    const rule = ROUTE_RULES['/api/tiles/**'];
    const caching = Object.keys(rule.headers ?? {}).filter((name) =>
      name.toLowerCase().endsWith('cache-control'),
    );
    expect(caching).toEqual(['Cache-Control']);
    expect([rule.cache, rule.swr, rule.isr, rule.prerender]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("none sets Vary, which h3 would put over the tile's own", () => {
    const reaching = Object.keys(ROUTE_RULES).filter(reachesTiles);
    expect(reaching).toContain('/api/tiles/**');
    const varying = reaching.filter((pattern) =>
      Object.keys(ROUTE_RULES[pattern].headers ?? {}).some(
        (name) => name.toLowerCase() === 'vary',
      ),
    );
    expect(varying).toEqual([]);
  });
});
