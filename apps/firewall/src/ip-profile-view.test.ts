import { describe, expect, test } from 'bun:test';

import type { Advice } from './ban-advice';
import {
  barWidth,
  envVarFor,
  fingerprintScopeNote,
  overrideWarning,
} from './ip-profile-view';

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
    rpcsPartial: false,
    shape: shapeOf([], 10),
    buckets: [],
    tells: [],
    // Undecidable is the honest default for a fixture: it must never be the state that renders
    // as a clean bill of health.
    uaCheck: { mismatched: null, share: null, note: 'baseline not read' },
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
  axes: [],
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

describe('envVarFor', () => {
  const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';

  test('the tier decides the list, not the kind — both tiers key on a JA4', () => {
    expect(envVarFor({ kind: 'ja4', value: DIG, why: '', tier: 'deny' })).toBe(
      'FW_BLOCKED_JA4',
    );
    expect(
      envVarFor({ kind: 'ja4', value: DIG, why: '', tier: 'challenge' }),
    ).toBe('FW_CHALLENGE_JA4');
  });

  test('a network lever names its own list and its manual step', () => {
    expect(
      envVarFor({ kind: 'asn', value: 'Some Net', why: '', tier: 'deny' }),
    ).toContain('FW_BLOCKED_ASN');
  });
});

describe('overrideWarning', () => {
  const advice = (over: Partial<Advice> = {}): Advice => ({
    verdict: 'leave',
    reasons: [],
    axes: [],
    blockers: [],
    leverNotes: [],
    ...over,
  });

  test('a legitimacy blocker outranks a lever note — it is about the client, not the handle', () => {
    const w = overrideWarning(
      advice({
        blockers: ['verified bot (googlebot:900)'],
        leverNotes: ['fingerprint x shows 340 rendering requests'],
      }),
    );
    expect(w).toContain('verified bot (googlebot:900)');
    expect(w).not.toContain('340 rendering');
  });

  test('falls back to the lever note when nothing blocked', () => {
    expect(
      overrideWarning(
        advice({ verdict: 'watch', leverNotes: ['reach unknown'] }),
      ),
    ).toContain('reach unknown');
  });

  test('always names the verdict being overridden', () => {
    expect(overrideWarning(advice({ verdict: 'challenge' }))).toContain(
      'verdict: challenge',
    );
  });

  test('says something even when the advisory found nothing at all', () => {
    // The operator still pressed the key; a blank detail reads as a broken dialog.
    expect(overrideWarning(advice())).toContain('nothing either way');
  });
});

describe('fingerprintScopeNote', () => {
  const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';

  test('warns that an IP profile denies the FINGERPRINT, since there is no IP lever', () => {
    const note = fingerprintScopeNote({ kind: 'ip', value: '1.2.3.4' }, DIG);
    expect(note).toContain(DIG);
    expect(note).toContain('NOT the IP 1.2.3.4');
  });

  test('says nothing when the subject already IS the fingerprint', () => {
    expect(fingerprintScopeNote({ kind: 'ja4', value: DIG }, DIG)).toBe('');
  });
});

describe('profileLines — the impersonation check', () => {
  const DIG = 't13d1516h2_cccccccccccc_222222222222';

  test('a contradiction reads as automated and names the rival fingerprint', () => {
    const text = render(
      profile({
        uaCheck: {
          mismatched: [
            {
              ua: 'Chrome/142.0.0.0 Safari/537.36',
              requests: 58,
              subjectShare: 0.071,
              rivalDigest: DIG,
              rivalShare: 0.764,
            },
          ],
          share: 0.139,
          note: '1 of 3 comparable user-agents belong to a DIFFERENT fingerprint',
        },
      }),
    );
    expect(text).toContain('ua vs TLS');
    expect(text).toContain('DIFFERENT fingerprint');
    expect(text).toContain(DIG);
    expect(text).toContain('58x');
  });

  test('undecidable renders as a note, NOT as browser evidence', () => {
    // The failure that matters: a check that could not run reading as a check that passed.
    const text = render(
      profile({
        uaCheck: {
          mismatched: null,
          share: null,
          note: 'the site-wide user-agent baseline could not be read',
        },
      }),
    );
    expect(text).toContain('could not be read');
    expect(text).not.toContain('consistent');
  });

  test('consistent renders, so a clean identity is visibly cleared rather than silent', () => {
    const text = render(
      profile({
        uaCheck: {
          mismatched: [],
          share: 0,
          note: 'every comparable user-agent (7) is consistent with this fingerprint',
        },
      }),
    );
    expect(text).toContain('is consistent with this fingerprint');
  });
});
