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
    wafRules: [],
    statuses: [['200', 9000]],
    digestReach: {
      label: 't13d311200_1d947a95fc68_7e1102d2036b',
      ips: 413,
      countries: 205,
      total: 171751,
      subResources: 0,
      beacons: 0,
      verifiedNames: [],
    },
    asnReach: {
      label: 'Consumer ISP',
      ips: 400,
      countries: 200,
      total: 171751,
      subResources: 9000, // consumer networks obviously serve real browsers
      beacons: 4000,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    alreadyDeniedAsn: false,
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
    wafRules: [],
    statuses: [['200', 9000]],
    digestReach: {
      label: 't13d2013h2_a09f3c656075_7f0f34a4126d',
      ips: 3,
      countries: 1,
      total: 663,
      subResources: 42,
      beacons: 60,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    alreadyDeniedAsn: false,
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

  test('an already-denied digest reads as handled, not as innocent', () => {
    // 'leave' would render as a green DO NOT DENY, which says the opposite of what happened.
    const a = adviseBan(scraper({ alreadyDeniedJa4: true }));
    expect(a.verdict).toBe('already');
    expect(a.blockers.join(' ')).toContain('already in FW_BLOCKED_JA4');
    expect(a.lever).toBeUndefined();
    // The evidence must survive: it is why the rule exists.
    expect(a.reasons.length).toBeGreaterThan(1);
  });

  test('a legitimate client that is also denied still reads as legitimate', () => {
    const a = adviseBan(
      scraper({ alreadyDeniedJa4: true, botVerified: [['pass', 500]] }),
    );
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('verified bot');
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
        digestReach: {
          label: 't13d1713h1_ab0a1bf427ad_ecd0401ec68b',
          ips: 229,
          countries: 16,
          total: 419,
          subResources: 0,
          beacons: 0,
          verifiedNames: ['claude-user'],
        },
      }),
    );
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('SHARED identity');
    expect(a.blockers.join(' ')).toContain('claude-user');
    // Blocking BOTH levers matters: the agent may egress from the same network, so an ASN
    // deny would catch it too.
    expect(a.lever).toBeUndefined();
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
        digestReach: {
          label: 't13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb',
          ips: 1,
          countries: 1,
          total: 9060,
          subResources: 0,
          beacons: 0,
          verifiedNames: [],
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
      digestReach: undefined,
      asnReach: undefined,
    });
    if (a.verdict === 'watch') expect(a.digest).toBeDefined();
  });
});

describe('adviseBan — first-party callers', () => {
  // ch-stream: Bun on Railway, POST /api/revalidate, matched by allow-ch-stream-revalidate.
  const chStream = (): AdviceInput => ({
    total: 1158,
    mix: mixOf([['/api/revalidate', 1158]]),
    shape: shapeOf(series(Array(144).fill(8), 0, 144), 10),
    ja4: [['t13d1714h1_5b57614c22b0_7baf387fc6ff', 1158]],
    asns: [['Railway', 1158]],
    botVerified: [],
    wafActions: [['bypass', 1158]],
    wafRules: [['allow-ch-stream-revalidate', 1158]],
    statuses: [['202', 1158]],
    digestReach: {
      label: 't13d1714h1_5b57614c22b0_7baf387fc6ff',
      ips: 1,
      countries: 1,
      total: 1158,
      subResources: 0,
      beacons: 0,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    alreadyDeniedAsn: false,
    windowMinutes: 1440,
  });

  test('our own cache-invalidation caller is never recommended for a deny', () => {
    const a = adviseBan(chStream());
    expect(a.verdict).toBe('leave');
  });

  test('the matched allow rule is named, and treated as an authentication fact', () => {
    const b = adviseBan(chStream()).blockers.join(' ');
    expect(b).toContain('allow-ch-stream-revalidate');
    expect(b).toContain('our own secret header');
  });

  test('an API-only client is blocked for having nothing to enumerate', () => {
    const a = adviseBan({
      ...chStream(),
      wafActions: [['log', 1158]],
      wafRules: [],
    statuses: [['200', 9000]],
    });
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('nothing here to enumerate');
  });

  test('/api/ paths are not counted as page fetches', () => {
    expect(mixOf([['/api/revalidate', 5]]).page).toBe(0);
    expect(mixOf([['/api/revalidate', 5]]).api).toBe(5);
  });
});

describe('adviseBan — the ASN lever', () => {
  // velia.net: 5 rotating JA4s over 4 IPs, walking /company/ alphabetically, ZERO sub-resources
  // across the whole ASN. The fingerprint rotates, so the network is the handle.
  const velia = (over: Partial<AdviceInput> = {}): AdviceInput => ({
    total: 1630,
    mix: mixOf([['/company/a', 1600], ['/sitemap-1.xml', 30]]),
    shape: shapeOf(series(Array(144).fill(11), 0, 144), 10),
    ja4: [['t13d3012h1_1d37bd780c83_882d495ac381', 1630]],
    asns: [['velia.net Internetdienste GmbH', 1630]],
    botVerified: [],
    wafActions: [['log', 1630]],
    wafRules: [],
    statuses: [['200', 9000]],
    // Rotating: this digest is shared with real browsers elsewhere, so JA4 is not available.
    digestReach: {
      label: 't13d3012h1_1d37bd780c83_882d495ac381',
      ips: 400,
      countries: 30,
      total: 50000,
      subResources: 900,
      beacons: 300,
      verifiedNames: [],
    },
    asnReach: {
      label: 'velia.net Internetdienste GmbH',
      ips: 4,
      countries: 1,
      total: 1630,
      subResources: 0,
      beacons: 0,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    alreadyDeniedAsn: false,
    windowMinutes: 1440,
    ...over,
  });

  test('falls back to the network when the fingerprint is shared with browsers', () => {
    const a = adviseBan(velia());
    expect(a.verdict).toBe('ban');
    expect(a.lever?.kind).toBe('asn');
    expect(a.lever?.value).toBe('velia.net Internetdienste GmbH');
  });

  test('the ASN lever demands the AS number, which observability cannot supply', () => {
    expect(adviseBan(velia()).lever?.needsAsNumber).toBe(true);
  });

  test('it says WHY the network cleared: zero sub-resources across all of it', () => {
    expect(adviseBan(velia()).lever?.why).toContain('ZERO sub-resources');
  });

  test('and why the fingerprint did not, so the choice is auditable', () => {
    expect(adviseBan(velia()).leverNotes.join(' ')).toContain(
      'real browsers render from it',
    );
  });

  test('a network that has EVER served a sub-resource is refused', () => {
    // DigitalOcean on the generic Chromium digest: 742 sub-resources. Not bannable.
    const a = adviseBan(
      velia({
        asnReach: {
          label: 'DigitalOcean, LLC',
          ips: 9,
          countries: 3,
          total: 1043,
          subResources: 742,
          beacons: 151,
          verifiedNames: [],
        },
      }),
    );
    expect(a.verdict).toBe('watch');
    expect(a.lever).toBeUndefined();
    expect(a.leverNotes.join(' ')).toContain('would hit users');
  });

  test('a network carrying a verified bot is refused even at zero sub-resources', () => {
    const a = adviseBan(
      velia({
        asnReach: {
          label: 'Google LLC',
          ips: 40,
          countries: 1,
          total: 5000,
          subResources: 0,
          beacons: 0,
          verifiedNames: ['googlebot'],
        },
      }),
    );
    expect(a.verdict).toBe('watch');
    expect(a.lever).toBeUndefined();
  });

  test('an unknown network reach is never cleared by default', () => {
    const a = adviseBan(velia({ asnReach: undefined }));
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain('reach unknown');
  });

  test('a clean fingerprint still wins — it survives IP rotation', () => {
    const a = adviseBan(
      velia({
        digestReach: {
          label: 't13d3012h1_1d37bd780c83_882d495ac381',
          ips: 4,
          countries: 1,
          total: 1630,
          subResources: 0,
          beacons: 0,
          verifiedNames: [],
        },
      }),
    );
    expect(a.lever?.kind).toBe('ja4');
  });
});

describe('adviseBan — is acting worth it', () => {
  // An Azure PHP-backdoor scanner: scraper-shaped, but already challenged on every request and
  // finding nothing. Still deniable, but the operator should know a deny buys very little.
  const prober = (): AdviceInput => ({
    total: 490,
    mix: mixOf([['/1.php', 200], ['/admin.php', 290]]),
    shape: shapeOf(series(Array(144).fill(4), 0, 144), 10),
    ja4: [['t13d201100_2b729b4bf6f3_36bf25f296df', 490]],
    asns: [['Microsoft Corporation', 490]],
    botVerified: [],
    wafActions: [['challenge', 490]],
    wafRules: [],
    statuses: [['429', 490]],
    digestReach: {
      label: 't13d201100_2b729b4bf6f3_36bf25f296df',
      ips: 8,
      countries: 5,
      total: 490,
      subResources: 0,
      beacons: 0,
      verifiedNames: [],
    },
    asnReach: {
      label: 'Microsoft Corporation',
      ips: 431,
      countries: 17,
      total: 4828,
      subResources: 221,
      beacons: 0,
      verifiedNames: ['bingbot', 'gptbot'],
    },
    alreadyDeniedJa4: false,
    alreadyDeniedAsn: false,
    windowMinutes: 1440,
  });

  test('still recommends the fingerprint, never the network', () => {
    const a = adviseBan(prober());
    expect(a.verdict).toBe('ban');
    expect(a.lever?.kind).toBe('ja4');
  });

  test('refuses the network because bingbot and gptbot egress from it', () => {
    expect(adviseBan(prober()).leverNotes.join(' ')).not.toContain(
      'ZERO sub-resources across 4828',
    );
  });

  test('says a deny buys little when managed rules already act on everything', () => {
    expect(adviseBan(prober()).leverNotes.join(' ')).toContain(
      'saves the challenge round-trip',
    );
  });

  test('distinguishes probing from harvesting when every response is 4xx', () => {
    expect(adviseBan(prober()).leverNotes.join(' ')).toContain(
      'probing rather than harvesting',
    );
  });

  test('a client that actually gets 200s is not called a prober', () => {
    const a = adviseBan({ ...prober(), statuses: [['200', 490]], wafActions: [['log', 490]] });
    expect(a.leverNotes.join(' ')).not.toContain('probing rather than harvesting');
  });
});
