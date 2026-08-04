// The verdict is the whole point of this view: it is what an operator acts on. The `shared` case
// is modelled on t13d1713h1_ab0a1bf427ad_ecd0401ec68b, which reads as a textbook scraper on shape
// alone but carries verified claude-user — denying it would take out verified agents.

import { describe, expect, test } from 'bun:test';

import { line, lineText, seg, truncate } from './line-model';
import type { SitemapDigest } from './sitemap-readers';
import { sitemapLines, verdictOf } from './sitemap-view';

function digest(over: Partial<SitemapDigest> = {}): SitemapDigest {
  return {
    ja4: 't13d1713h1_ab0a1bf427ad_ecd0401ec68b',
    fetches: 5,
    ips: ['47.79.13.37'],
    asns: ['Alibaba (US) Technology Co., Ltd.'],
    denied: false,
    verifiedAs: [],
    verifiedOffSitemap: false,
    enriched: true,
    total: 406,
    companyPages: 336,
    subResources: 0,
    distinctPaths: 330,
    ...over,
  };
}

describe('verdictOf', () => {
  test('unverified sitemap read followed by a /company/ walk is ENUMERATED', () => {
    expect(verdictOf(digest()).label).toBe('ENUMERATED');
    expect(verdictOf(digest()).tone).toBe('bad');
  });

  test('the same shape carrying a verified agent is SHARED, never a deny candidate', () => {
    const v = verdictOf(
      digest({ verifiedAs: ['claude-user'], verifiedOffSitemap: true }),
    );
    expect(v.label).toBe('shared');
    expect(v.note).toContain('claude-user');
    // Leads with the instruction: the TUI pane truncates, and this must survive the cut.
    expect(v.note?.startsWith('DO NOT DENY')).toBe(true);
    expect(truncate(line(seg(v.note ?? '')), 30).map((s) => s.text).join('')).toContain(
      'DO NOT DENY',
    );
  });

  test('a verified crawler that did not enumerate is just verified', () => {
    const v = verdictOf(
      digest({ verifiedAs: ['googlebot'], companyPages: 2, total: 20 }),
    );
    expect(v.label).toBe('verified');
  });

  test('verification found only off-sitemap is called out', () => {
    const v = verdictOf(
      digest({
        verifiedAs: ['claude-user'],
        verifiedOffSitemap: true,
        companyPages: 1,
      }),
    );
    expect(v.label).toBe('verified');
    expect(v.note).toContain('wider traffic');
  });

  test('an already-denied digest is not re-flagged as a new find', () => {
    expect(verdictOf(digest({ denied: true })).label).toBe('denied');
  });

  test('a sitemap read with no follow-up is unreviewed, not a conviction', () => {
    expect(
      verdictOf(digest({ companyPages: 0, total: 9, distinctPaths: 7 })).label,
    ).toBe('unreviewed');
  });

  test('un-enriched digests are never convicted on missing data', () => {
    expect(
      verdictOf(
        digest({ enriched: false, companyPages: undefined, total: undefined }),
      ).label,
    ).toBe('unreviewed');
  });
});

describe('sitemapLines', () => {
  const report = (digests: SitemapDigest[]) => ({
    start: '2026-07-29T09:00:00.000Z',
    end: '2026-08-04T09:00:00.000Z',
    windowHours: 144,
    fetches: 190,
    ips: 151,
    paths: [['/sitemap.xml', 50]] as [string, number][],
    verified: [['bingbot', 76]] as [string, number][],
    digests,
    errors: [],
  });

  test('an all-clear window says so rather than staying silent', () => {
    const text = sitemapLines(report([digest({ companyPages: 0, total: 9 })]))
      .map(lineText)
      .join('\n');
    expect(text).toContain('nothing unverified went on to enumerate');
  });

  test('a shared fingerprint raises the check-before-denying banner', () => {
    const text = sitemapLines(
      report([digest({ verifiedAs: ['claude-user'], verifiedOffSitemap: true })]),
    )
      .map(lineText)
      .join('\n');
    expect(text).toContain('also carry verified agents');
    expect(text).toContain('nothing unverified went on to enumerate');
  });

  test('a real enumeration is reported as one', () => {
    const text = sitemapLines(report([digest()]))
      .map(lineText)
      .join('\n');
    expect(text).toContain('1 unverified fingerprint(s) read a sitemap then enumerated');
  });

  test('truncated path samples are marked as floors, not totals', () => {
    const text = sitemapLines(
      report([digest({ total: 176900, companyPages: 705, pathsPartial: true })]),
    )
      .map(lineText)
      .join('\n');
    expect(text).toContain('176900 req total');
    expect(text).toContain('≥705 /company/');
    expect(text).toContain('truncated');
  });
});
