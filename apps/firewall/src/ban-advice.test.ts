// Fixtures are the three real clients this session turned up:
//   the residential-proxy scraper  — must recommend a deny
//   the Newcastle job seeker       — must never be recommended
//   t13d1713h1_… shared with claude-user — scraper-shaped, must be blocked

import { describe, expect, test } from 'bun:test';

import { type AdviceInput, adviseBan } from './ban-advice';
import { type Mix, mixOf, shapeOf } from './ip-signals';

function series(counts: number[], offset: number, length: number) {
  const base = Date.parse('2026-08-03T00:00:00.000Z');
  return Array.from({ length }, (_, i) => ({
    t: new Date(base + i * 600_000).toISOString(),
    c: i >= offset && i - offset < counts.length ? counts[i - offset] : 0,
  }));
}

const scraperMix: Mix = mixOf([
  ['/company/a', 5000],
  ['/company/b', 4000],
  ['/sitemap-1.xml', 60],
]);

function scraper(over: Partial<AdviceInput> = {}): AdviceInput {
  return {
    total: 9060,
    mix: scraperMix,
    shape: shapeOf(series(Array(144).fill(63), 0, 144), 10),
    ja4: [['t13d311200_1d947a95fc68_7e1102d2036b', 9060]],
    asns: [['Consumer ISP', 9060]],
    botVerified: [],
    wafActions: [['log', 9060]],
    reach: {
      ja4: 't13d311200_1d947a95fc68_7e1102d2036b',
      ips: 413,
      countries: 205,
      verifiedNames: [],
      total: 171751,
    },
    alreadyDenied: false,
    windowMinutes: 1440,
    ...over,
  };
}

function human(over: Partial<AdviceInput> = {}): AdviceInput {
  const mix = mixOf([
    ['/_serverFn/a', 469],
    ['/_vercel/insights/view', 60],
    ['/assets/index.js', 42],
    ['/', 5],
  ]);
  return {
    total: 663,
    mix,
    shape: shapeOf(series([246, 105, 177, 135], 120, 144), 10),
    ja4: [['t13d2013h2_a09f3c656075_7f0f34a4126d', 662]],
    asns: [['British Telecommunications Limited', 663]],
    botVerified: [],
    wafActions: [['allow', 662]],
    reach: {
      ja4: 't13d2013h2_a09f3c656075_7f0f34a4126d',
      ips: 3,
      countries: 1,
      verifiedNames: [],
      total: 663,
    },
    alreadyDenied: false,
    windowMinutes: 1440,
    ...over,
  };
}

describe('adviseBan — the scraper', () => {
  test('recommends a deny on its digest, not its IP', () => {
    const a = adviseBan(scraper());
    expect(a.verdict).toBe('ban');
    expect(a.digest).toBe('t13d311200_1d947a95fc68_7e1102d2036b');
    expect(a.blockers).toEqual([]);
  });

  test('says why the digest is the handle', () => {
    expect(adviseBan(scraper()).reasons.join(' ')).toContain('413 IPs');
  });

  test('an already-denied digest is left alone', () => {
    const a = adviseBan(scraper({ alreadyDenied: true }));
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('already in FW_BLOCKED_JA4');
  });
});

describe('adviseBan — the real user', () => {
  test('is never recommended for a deny', () => {
    const a = adviseBan(human());
    expect(a.verdict).toBe('leave');
  });

  test('is blocked on the evidence a browser leaves behind', () => {
    const b = adviseBan(human()).blockers.join(' ');
    expect(b).toContain('analytics beacons');
    expect(b).toContain('sub-resource');
  });
});

describe('adviseBan — the blockers that matter', () => {
  test('a verified bot is never recommended, however scraper-shaped', () => {
    const a = adviseBan(scraper({ botVerified: [['pass', 500]] }));
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('verified bot');
  });

  test('a digest SHARED with a verified agent is blocked even when this IP looks clean', () => {
    // t13d1713h1_…: 229 IPs, zero sub-resources, 336 /company/ — and carries claude-user.
    const a = adviseBan(
      scraper({
        ja4: [['t13d1713h1_ab0a1bf427ad_ecd0401ec68b', 9060]],
        reach: {
          ja4: 't13d1713h1_ab0a1bf427ad_ecd0401ec68b',
          ips: 229,
          countries: 16,
          verifiedNames: ['claude-user'],
          total: 419,
        },
      }),
    );
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('SHARED client fingerprint');
    expect(a.blockers.join(' ')).toContain('claude-user');
  });

  test('a quiet client is not worth a rule', () => {
    const a = adviseBan(scraper({ total: 40 }));
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('not worth a rule');
  });

  test('no fingerprint means nothing to deny on', () => {
    const a = adviseBan(scraper({ ja4: [] }));
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('no TLS fingerprint');
  });
});

describe('adviseBan — the one-tell threshold', () => {
  test('a single axis is inconclusive, never a deny', () => {
    // No assets, but low volume aside: everything else looks ordinary.
    const a = adviseBan(
      scraper({
        mix: mixOf([['/company/a', 9060]]),
        shape: shapeOf(series([9060], 10, 144), 10),
        ja4: [['t13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb', 9060]],
        reach: {
          ja4: 't13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb',
          ips: 1,
          countries: 1,
          verifiedNames: [],
          total: 9060,
        },
      }),
    );
    expect(a.reasons.length).toBeGreaterThan(0);
    expect(['watch', 'ban']).toContain(a.verdict);
  });

  test('watch still reports the digest, so it can be staged deliberately', () => {
    const a = adviseBan({
      ...scraper(),
      mix: mixOf([['/company/a', 9060], ['/assets/x.js', 0]]),
      shape: shapeOf(series([9060], 10, 144), 10),
      ja4: [['t13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb', 9060]],
      reach: undefined,
    });
    if (a.verdict === 'watch') expect(a.digest).toBeDefined();
  });
});
