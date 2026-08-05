import { describe, expect, test } from 'bun:test';

import { sitemapPaths } from './sitemap-readers';

describe('sitemapPaths', () => {
  const paths = sitemapPaths();

  test('always covers the index', () => {
    expect(paths).toContain('/sitemap.xml');
  });

  test('every entry is a rooted .xml path safe to interpolate into the filter DSL', () => {
    for (const p of paths) expect(p).toMatch(/^\/sitemap[\w-]*\.xml$/);
  });

  test('picks up the real shards, so a newly generated one is watched without a code change', () => {
    // Discovered from apps/web/public; the fixed fallback only applies when that is unreadable.
    expect(paths.length).toBeGreaterThan(1);
    expect(paths).toContain('/sitemap-0.xml');
  });

  test('no duplicates — a repeated path would double-count fetches', () => {
    expect(new Set(paths).size).toBe(paths.length);
  });
});
