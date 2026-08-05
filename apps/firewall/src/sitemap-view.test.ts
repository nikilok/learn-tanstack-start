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
    expect(
      truncate(line(seg(v.note ?? '')), 30)
        .map((s) => s.text)
        .join(''),
    ).toContain('DO NOT DENY');
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
    windowLabel: 'last 6d',
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
      report([
        digest({ verifiedAs: ['claude-user'], verifiedOffSitemap: true }),
      ]),
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
    expect(text).toContain(
      '1 unverified fingerprint(s) read a sitemap then enumerated',
    );
  });

  test('a total that fell back to the path sum is marked as a floor too', () => {
    // totalExact is false when the exact wafAction query failed, so `total` IS the truncated
    // path sum — printing it bare presents a floor as a measurement.
    const text = sitemapLines(
      report([
        digest({
          total: 12000,
          companyPages: 9000,
          pathsPartial: true,
          totalExact: false,
        }),
      ]),
    )
      .map(lineText)
      .join('\n');
    expect(text).toContain('≥12000 req total');
  });

  test('an exact total is printed bare even when the path sample was cut', () => {
    const text = sitemapLines(
      report([
        digest({
          total: 176900,
          companyPages: 705,
          pathsPartial: true,
          totalExact: true,
        }),
      ]),
    )
      .map(lineText)
      .join('\n');
    expect(text).toContain('176900 req total');
    expect(text).not.toContain('≥176900');
    expect(text).toContain('≥705 /company/');
  });

  test('truncated path samples are marked as floors, not totals', () => {
    const text = sitemapLines(
      report([
        digest({ total: 176900, companyPages: 705, pathsPartial: true }),
      ]),
    )
      .map(lineText)
      .join('\n');
    expect(text).toContain('176900 req total');
    expect(text).toContain('≥705 /company/');
    expect(text).toContain('truncated');
  });
});

describe('sitemapLines — selection', () => {
  const report = (digests: SitemapDigest[]) => ({
    start: '2026-07-29T09:00:00.000Z',
    end: '2026-08-04T09:00:00.000Z',
    windowHours: 144,
    windowLabel: 'last 6d',
    fetches: 190,
    ips: 151,
    paths: [] as [string, number][],
    verified: [] as [string, number][],
    digests,
    errors: [],
  });
  const two = [
    digest(),
    digest({ ja4: 't13d311200_1d947a95fc68_7e1102d2036b' }),
  ];

  test('exactly one row is marked, and it is the cursor', () => {
    const text = sitemapLines(report(two), 1).map(lineText).join('\n');
    expect(text.split('▶').length - 1).toBe(1);
    expect(text.split('\n').find((l) => l.includes('▶'))).toContain(
      't13d311200',
    );
  });

  test('no cursor marks nothing — the CLI renders the same view', () => {
    expect(sitemapLines(report(two)).map(lineText).join('\n')).not.toContain(
      '▶',
    );
  });

  test('the window label is shown, so a re-scoped report cannot read as the old one', () => {
    const text = sitemapLines(report(two), 0).map(lineText).join('\n');
    expect(text).toContain('last 6d');
  });

  test('the list advertises that it is navigable', () => {
    expect(sitemapLines(report(two), 0).map(lineText).join('\n')).toContain(
      '↑↓ select',
    );
  });
});
