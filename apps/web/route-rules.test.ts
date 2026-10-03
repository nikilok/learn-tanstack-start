import { describe, expect, test } from 'bun:test';

import type { NitroRouteConfig } from 'nitro/types';

import { ROUTE_RULES } from './route-rules';

/** Whether a rule makes Nitro or Vercel cache responses: any *Cache-Control header, or a cache, swr, isr, prerender or legacy static:false option. */
function setsCaching(rule: NitroRouteConfig): boolean {
  const header = Object.keys(rule.headers ?? {}).some((name) =>
    name.toLowerCase().endsWith('cache-control'),
  );
  return (
    header ||
    Boolean(rule.cache || rule.swr || rule.isr || rule.prerender) ||
    rule.static === false
  );
}

describe('setsCaching', () => {
  test.each<[string, NitroRouteConfig]>([
    ['Cache-Control', { headers: { 'Cache-Control': 's-maxage=60' } }],
    ['CDN-Cache-Control', { headers: { 'CDN-Cache-Control': 's-maxage=60' } }],
    [
      'Vercel-CDN-Cache-Control',
      { headers: { 'vercel-cdn-cache-control': 'x' } },
    ],
    ['swr', { swr: 3600 }],
    ['cache', { cache: { maxAge: 60 } }],
    ['isr', { isr: 60 }],
    ['prerender', { prerender: true }],
    ['static: false (legacy ISR)', { static: false }],
  ])('%s caches', (_, rule) => {
    expect(setsCaching(rule)).toBe(true);
  });

  test.each<[string, NitroRouteConfig]>([
    ['other headers', { headers: { 'X-Frame-Options': 'SAMEORIGIN' } }],
    ['a proxy', { proxy: 'https://example.com/**' }],
    ['static: true', { static: true }],
    ['cache: false', { cache: false }],
  ])('%s does not', (_, rule) => {
    expect(setsCaching(rule)).toBe(false);
  });
});

describe('ROUTE_RULES', () => {
  // Nitro merges a rule's headers over a 2xx response's own. A '/company/**'
  // rule set s-maxage=2592000 that way over every company document, so
  // degraded documents were edge-cached for 30 days instead of 5 minutes;
  // /download's owner document would lose its private, no-store the same way.
  test('only the tile proxy and the service worker set caching', () => {
    const caching = Object.keys(ROUTE_RULES).filter((pattern) =>
      setsCaching(ROUTE_RULES[pattern]),
    );
    expect(caching).toEqual(['/api/tiles/**', '/sw.js']);
  });
});
