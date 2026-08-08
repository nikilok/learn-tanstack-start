import { describe, expect, test } from 'bun:test';

import { barWidth } from './ip-profile-view';

describe('barWidth', () => {
  test('scales with the pane so a wide split is actually used', () => {
    expect(barWidth(140)).toBeGreaterThan(barWidth(60));
  });

  test('never collapses to nothing in a narrow pane', () => {
    expect(barWidth(30)).toBeGreaterThanOrEqual(20);
    expect(barWidth(0)).toBeGreaterThanOrEqual(20);
  });

  test('caps out, since past a point longer bars stop being comparable', () => {
    expect(barWidth(400)).toBe(barWidth(1000));
  });

  test('leaves room for the stamp and count columns', () => {
    // The bar starts ~26 cols in; it must not push the line past the pane.
    for (const w of [60, 100, 140])
      expect(barWidth(w) + 26).toBeLessThanOrEqual(w);
  });
});

import { ageLabel } from './ip-profile-view';

describe('ageLabel', () => {
  const t0 = Date.parse('2026-08-04T12:00:00.000Z');
  const at = (secs: number) =>
    ageLabel('2026-08-04T12:00:00.000Z', t0 + secs * 1000);

  test('a fresh snapshot reads as current', () => {
    expect(at(0)).toBe('just now');
    expect(at(30)).toBe('just now');
  });

  test('a stale one says how stale — a live window must not imply currency', () => {
    expect(at(300)).toBe('5m ago');
    expect(at(3600)).toBe('1h ago');
    expect(at(5400)).toBe('1h 30m ago');
  });

  test('a clock skewed backwards does not produce a negative age', () => {
    expect(at(-120)).toBe('just now');
  });
});

import type { IpProfile } from './ip-profile';
import { profileLines } from './ip-profile-view';
import { mixOf, shapeOf } from './ip-signals';
// Regression: the data layer sets mixPartial and Reach.complete precisely so a truncated or
// failed sample cannot read as a measured absence — and neither reached the screen, which is
// where the operator actually decides a blanket deny.
import { lineText } from './line-model';

function profile(over: Partial<IpProfile> = {}): IpProfile {
  return {
    subject: { kind: 'ip', value: '1.2.3.4' },
    ip: '1.2.3.4',
    start: '2026-08-04T00:00:00.000Z',
    end: '2026-08-05T00:00:00.000Z',
    windowHours: 24,
    windowLabel: 'last 24h',
    fetchedAt: '2026-08-05T00:00:00.000Z',
    total: 5000,
    byStatus: [['200', 5000]],
    byUserAgent: [],
    byJa4: [['t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb', 5000]],
    byIp: [],
    byAsn: [],
    byCountry: [],
    byBot: [],
    byBotVerified: [],
    verifiedBots: [],
    byWafAction: [],
    byWafRule: [],
    byPath: [['/company/a', 5000]],
    byReferrer: [],
    mix: mixOf([['/company/a', 5000]]),
    mixPartial: false,
    shape: shapeOf([], 10),
    buckets: [],
    tells: [],
    reachHours: 144,
    failedQueries: [],
    errors: [],
    ...over,
  };
}

// Reach only renders inside the RECOMMENDATION block, which needs an advice.
const ADVICE = {
  verdict: 'watch' as const,
  reasons: [],
  blockers: [],
  leverNotes: [],
};
const render = (p: IpProfile) =>
  profileLines(p, 120, ADVICE).map(lineText).join('\n');

describe('profileLines — partial data', () => {
  test('a complete sample prints bare counts', () => {
    const text = render(profile());
    expect(text).not.toContain('truncated by the API');
    expect(text).toContain('page 5000');
  });

  test('a truncated path sample marks every mix count as a floor', () => {
    const text = render(profile({ mixPartial: true }));
    expect(text).toContain('truncated by the API');
    expect(text).toContain('≥5000');
    expect(text).toContain('a zero may be a dropped tail');
  });

  test('an incomplete reach says so rather than printing a confident zero', () => {
    const text = render(
      profile({
        digestReach: {
          label: 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb',
          ips: 400,
          countries: 200,
          total: 171751,
          subResources: 0,
          beacons: 0,
          tiles: 0,
          rpcs: 0,
          complete: false,
          verifiedNames: [],
        },
      }),
    );
    expect(text).toContain('sample incomplete');
    expect(text).toContain('≥0 rendering requests');
  });

  test('a complete reach prints its figures plainly', () => {
    const text = render(
      profile({
        digestReach: {
          label: 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb',
          ips: 400,
          countries: 200,
          total: 171751,
          subResources: 12,
          beacons: 3,
          tiles: 0,
          rpcs: 0,
          complete: true,
          verifiedNames: [],
        },
      }),
    );
    expect(text).not.toContain('sample incomplete');
    expect(text).toContain('15 rendering requests');
  });

  test('the reach line counts tiles and RPCs, not just assets and beacons', () => {
    // Regression: it summed subResources + beacons only, so a returning user with a warm cache
    // and an ad-blocker — no assets, no beacons, but thousands of tiles and RPCs — rendered as
    // '0 sub-resources' on the one line an operator reads before a blanket deny.
    const text = render(
      profile({
        digestReach: {
          label: 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb',
          ips: 12,
          countries: 2,
          total: 9000,
          subResources: 0,
          beacons: 0,
          tiles: 400,
          rpcs: 3000,
          complete: true,
          verifiedNames: [],
        },
      }),
    );
    expect(text).toContain('3400 rendering requests');
    // The old line summed assets + beacons only, which for this reach is exactly zero.
    expect(text).not.toMatch(/[^\d]0 rendering requests/);
  });
});
