// Fixtures are the three real clients this session turned up:
//   the residential-proxy scraper  — must recommend a deny
//   the Newcastle job seeker       — must never be recommended
//   t13d1713h1_… shared with claude-user — scraper-shaped, must be blocked

import { describe, expect, test } from 'bun:test';

import {
  HEADER_GATED_RULES,
  WAF_RULE_QUERY,
  adviseBan,
  type AdviceInput,
  type Reach,
  volumeFloor,
} from './ban-advice';
import { type Mix, dutyCycleOf, mixOf, shapeOf } from './ip-signals';
import { CH_STREAM_REVALIDATE, DESKTOP_RELEASE_RECORD } from './rule-names';

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
    ja4: [['t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb', 9060]],
    asns: [['Consumer ISP', 9060]],
    botVerified: [],
    wafActions: [['log', 9060]],
    wafRules: [],
    statuses: [['200', 9000]],
    digestReach: {
      label: 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb',
      ips: 413,
      countries: 205,
      total: 171751,
      subResources: 0,
      beacons: 0,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    },
    asnReach: {
      label: 'Consumer ISP',
      ips: 400,
      countries: 200,
      total: 171751,
      subResources: 9000, // consumer networks obviously serve real browsers
      beacons: 4000,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    stagedJa4: false,
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
    ja4: [['t13dhumnh2_cccccccccccc_dddddddddddd', 662]],
    asns: [['British Telecommunications Limited', 663]],
    botVerified: [],
    wafActions: [['allow', 662]],
    wafRules: [],
    statuses: [['200', 9000]],
    digestReach: {
      label: 't13dhumnh2_cccccccccccc_dddddddddddd',
      ips: 3,
      countries: 1,
      total: 663,
      subResources: 42,
      beacons: 60,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    stagedJa4: false,
    alreadyDeniedAsn: false,
    windowMinutes: 1440,
    ...over,
  };
}

describe('adviseBan — the scraper', () => {
  test('recommends a deny on its digest, not its IP', () => {
    const a = adviseBan(scraper());
    expect(a.verdict).toBe('ban');
    expect(a.digest).toBe('t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb');
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
        ja4: [['t13dshrdh1_111111111111_222222222222', 9060]],
        digestReach: {
          label: 't13dshrdh1_111111111111_222222222222',
          ips: 229,
          countries: 16,
          total: 419,
          subResources: 0,
          beacons: 0,
          tiles: 0,
          rpcs: 0,
          complete: true,
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

  test('too little traffic to judge is INCONCLUSIVE, never a green all-clear', () => {
    // Rendering "too few requests" as DO NOT DENY told the operator the client was fine when
    // the truth was that the window was too narrow to say anything.
    const a = adviseBan(scraper({ total: 40 }));
    expect(a.verdict).toBe('watch');
    expect(a.blockers).toEqual([]);
    expect(a.leverNotes.join(' ')).toContain('too little to judge');
    expect(a.leverNotes.join(' ')).toContain('Widen the window');
  });

  test('an already-denied fingerprint stays ALREADY DENIED in a narrow window', () => {
    // Live view of a banned scraper: 16 requests. It must not read as DO NOT DENY.
    const a = adviseBan(
      scraper({ total: 16, alreadyDeniedJa4: true, windowMinutes: 20 }),
    );
    expect(a.verdict).toBe('already');
    expect(a.blockers.join(' ')).toContain('already in FW_BLOCKED_JA4');
  });

  test('the volume bar scales with the window', () => {
    // 200 requests in 24h is quiet; the same 200 in 20 minutes is a scrape.
    expect(volumeFloor(1440)).toBe(200);
    expect(volumeFloor(360)).toBe(50);
    expect(volumeFloor(20)).toBe(50);
    // A scraper's 20-minute volume clears it easily.
    expect(volumeFloor(20)).toBeLessThan(1700);
  });

  test('no fingerprint means nothing to identify it by', () => {
    const a = adviseBan(scraper({ ja4: [] }));
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain('no TLS fingerprint');
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
          tiles: 0,
          rpcs: 0,
          complete: true,
          verifiedNames: [],
        },
      }),
    );
    expect(a.reasons.length).toBeGreaterThan(0);
    // Exact: one axis (rendering) is all that fires here — pages-only mix, an ALPN-negotiating
    // digest, no crawl, a near-zero duty cycle and a single-IP reach. Accepting 'ban' would let
    // a change that made ONE axis sufficient slip through green.
    expect(a.verdict).toBe('watch');
  });

  test('watch still reports the digest, so it can be staged deliberately', () => {
    const a = adviseBan({
      ...scraper(),
      mix: mixOf([
        ['/company/a', 9060],
        ['/assets/x.js', 0],
      ]),
      shape: shapeOf(series([9060], 10, 144), 10),
      ja4: [['t13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb', 9060]],
      digestReach: undefined,
      asnReach: undefined,
    });
    // Unconditional: the guard made the assertion vacuous in exactly the case that matters.
    expect(a.verdict).toBe('watch');
    expect(a.digest).toBeDefined();
  });
});

describe('adviseBan — first-party callers', () => {
  // ch-stream: Bun on Railway, POST /api/revalidate, matched by allow-ch-stream-revalidate.
  const chStream = (): AdviceInput => ({
    total: 1158,
    mix: mixOf([['/api/revalidate', 1158]]),
    shape: shapeOf(series(Array(144).fill(8), 0, 144), 10),
    ja4: [['t13dpolah1_777777777777_888888888888', 1158]],
    asns: [['Railway', 1158]],
    botVerified: [],
    wafActions: [['bypass', 1158]],
    wafRules: [['allow-ch-stream-revalidate', 1158]],
    statuses: [['202', 1158]],
    digestReach: {
      label: 't13dpolah1_777777777777_888888888888',
      ips: 1,
      countries: 1,
      total: 1158,
      subResources: 0,
      beacons: 0,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    stagedJa4: false,
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
    mix: mixOf([
      ['/company/a', 1600],
      ['/sitemap-1.xml', 30],
    ]),
    shape: shapeOf(series(Array(144).fill(11), 0, 144), 10),
    ja4: [['t13dvelah1_eeeeeeeeeeee_ffffffffffff', 1630]],
    asns: [['velia.net Internetdienste GmbH', 1630]],
    botVerified: [],
    wafActions: [['log', 1630]],
    wafRules: [],
    statuses: [['200', 9000]],
    // Rotating: this digest is shared with real browsers elsewhere, so JA4 is not available.
    digestReach: {
      label: 't13dvelah1_eeeeeeeeeeee_ffffffffffff',
      ips: 400,
      countries: 30,
      total: 50000,
      subResources: 900,
      beacons: 300,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    },
    asnReach: {
      label: 'velia.net Internetdienste GmbH',
      ips: 4,
      countries: 1,
      total: 1630,
      subResources: 0,
      beacons: 0,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    },
    alreadyDeniedJa4: false,
    stagedJa4: false,
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
    expect(adviseBan(velia()).lever?.why).toContain('ZERO rendering requests');
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
          tiles: 0,
          rpcs: 0,
          complete: true,
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
          tiles: 0,
          rpcs: 0,
          complete: true,
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

  test('the shared fingerprint falls through to the network lever', () => {
    // velia's digest carries 1,200 rendering requests elsewhere, so a ja4 deny would take real
    // browsers with it; the network is the tighter handle.
    const a = adviseBan(velia({}));
    expect(a.verdict).toBe('ban');
    expect(a.lever?.kind).toBe('asn');
  });

  test('a clean fingerprint wins the lever when a second axis is present', () => {
    // Clean reach AND wide spread (40 IPs), so rendering + spread are two independent axes.
    const a = adviseBan(
      velia({
        digestReach: {
          label: 't13dvelah1_eeeeeeeeeeee_ffffffffffff',
          ips: 40,
          countries: 5,
          total: 1630,
          subResources: 0,
          beacons: 0,
          tiles: 0,
          rpcs: 0,
          complete: true,
          verifiedNames: [],
        },
      }),
    );
    expect(a.lever?.kind).toBe('ja4');
  });

  const concentrated = (over: Partial<Reach> = {}): Reach => ({
    label: 't13dvelah1_eeeeeeeeeeee_ffffffffffff',
    ips: 4,
    countries: 1,
    total: 1630,
    subResources: 0,
    beacons: 0,
    tiles: 0,
    rpcs: 0,
    complete: true,
    verifiedNames: [],
    ...over,
  });

  test('a raw-HTML enumerator on few IPs bans on rendering + pacing', () => {
    // 144 flat 10-minute buckets from an identity on 4 IPs. `crawl` is entailed by `rendering`
    // so it cannot be the second axis; `pacing` is, and only became reachable once its
    // self-contradictory `concentration < 0.5` clause was dropped.
    const a = adviseBan(velia({ digestReach: concentrated() }));
    expect(a.verdict).toBe('ban');
    expect(a.lever?.kind).toBe('ja4');
    expect(a.reasons.join(' ')).toContain('busy in 100%');
  });

  test('pacing does NOT fire for a wide-spread identity — that rhythm is a population', () => {
    // The same flat traffic on 400 IPs is a shared fingerprint, not one machine. It still bans,
    // but on `spread`, and the reasons must not claim a pacing observation about one actor.
    const a = adviseBan(
      velia({ digestReach: concentrated({ ips: 400, countries: 30 }) }),
    );
    expect(a.reasons.join(' ')).not.toContain('busy in');
    expect(a.reasons.join(' ')).toContain('spans 400 IPs');
  });

  test('pacing does NOT fire on a SHORT window, where duty degenerates', () => {
    // The live preset is 20 minutes = TWO 10-minute buckets, so a human active in both scores
    // 100% duty. The 0.5 threshold was calibrated over 24h and does not transfer down — without
    // a bucket floor this fires on ordinary browsing on the watch screen.
    const buckets = series([30, 25], 0, 2);
    const a = adviseBan(
      velia({
        total: 55,
        shape: shapeOf(buckets, 10),
        windowMinutes: 20,
        digestReach: concentrated(),
      }),
    );
    expect(dutyCycleOf(shapeOf(buckets, 10), 20)).toBe(1); // the degeneracy is real
    expect(a.reasons.join(' ')).not.toContain('busy in');
  });

  test('pacing does NOT fire on the 1h preset either', () => {
    // A 35-minute visit across six buckets is 67% duty — over the threshold, under the floor.
    const a = adviseBan(
      velia({
        total: 60,
        shape: shapeOf(series([10, 10, 10, 10, 0, 0], 0, 6), 10),
        windowMinutes: 60,
        digestReach: concentrated(),
      }),
    );
    expect(a.reasons.join(' ')).not.toContain('busy in');
  });

  test('pacing DOES fire once the window holds enough buckets', () => {
    // 24h at 10-minute granularity is 144 buckets — the span the threshold was calibrated on.
    const a = adviseBan(velia({ digestReach: concentrated() }));
    expect(a.reasons.join(' ')).toContain('busy in 100%');
  });

  test('pacing does NOT fire when reach is unknown', () => {
    // Unknown is not narrow. Without reach there is no basis for "this is one actor".
    const a = adviseBan(velia({ digestReach: undefined }));
    expect(a.reasons.join(' ')).not.toContain('busy in');
  });

  test('a concentrated identity that is NOT level keeps its pacing axis quiet', () => {
    // One 40-minute burst out of 24h — 3% duty. Level is the claim, not merely "few IPs".
    const a = adviseBan(
      velia({
        shape: shapeOf(series([246, 105, 177, 135], 120, 144), 10),
        digestReach: concentrated(),
      }),
    );
    expect(a.reasons.join(' ')).not.toContain('busy in');
  });

  test('a polite unverified crawler is not banned on the sitemap pattern alone', () => {
    // Regression: crawl and rendering were separate axes, so "a crawler that does not run
    // JavaScript" satisfied the two-axes rule by itself and DENY RECOMMENDED a niche search
    // engine or an llms.txt-respecting agent.
    const a = adviseBan(
      velia({
        total: 1800,
        mix: mixOf([
          ['/robots.txt', 2],
          ['/sitemap.xml', 3],
          ['/company/aaa', 900],
          ['/company/bbb', 895],
        ]),
        ja4: [['t13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb', 1800]],
        shape: shapeOf(series([1800], 10, 144), 10),
        digestReach: {
          label: 't13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb',
          ips: 1,
          countries: 1,
          total: 1800,
          subResources: 0,
          beacons: 0,
          tiles: 0,
          rpcs: 0,
          complete: true,
          verifiedNames: [],
        },
      }),
    );
    // Exact: `not.toBe('ban')` also passes on leave/already/staged, which would hide a change in
    // how a polite unverified crawler is classified. One rendering axis means `watch`.
    expect(a.verdict).toBe('watch');
  });
});

describe('adviseBan — is acting worth it', () => {
  // An Azure PHP-backdoor scanner: scraper-shaped, but already challenged on every request and
  // finding nothing. Still deniable, but the operator should know a deny buys very little.
  const prober = (): AdviceInput => ({
    total: 490,
    mix: mixOf([
      ['/1.php', 200],
      ['/admin.php', 290],
    ]),
    shape: shapeOf(series(Array(144).fill(4), 0, 144), 10),
    ja4: [['t13dscan00_555555555555_666666666666', 490]],
    asns: [['Microsoft Corporation', 490]],
    botVerified: [],
    wafActions: [['challenge', 490]],
    wafRules: [],
    statuses: [['429', 490]],
    digestReach: {
      label: 't13dscan00_555555555555_666666666666',
      ips: 8,
      countries: 5,
      total: 490,
      subResources: 0,
      beacons: 0,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    },
    asnReach: {
      label: 'Microsoft Corporation',
      ips: 431,
      countries: 17,
      total: 4828,
      subResources: 221,
      beacons: 0,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: ['bingbot', 'gptbot'],
    },
    alreadyDeniedJa4: false,
    stagedJa4: false,
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
    const a = adviseBan({
      ...prober(),
      statuses: [['200', 490]],
      wafActions: [['log', 490]],
    });
    expect(a.leverNotes.join(' ')).not.toContain(
      'probing rather than harvesting',
    );
  });
});

// Every case below is a defect the max-effort review found. Each would clear, or fail to clear,
// a deny that takes real users offline.
describe('adviseBan — review regressions', () => {
  const reach = (over = {}) => ({
    label: 'x',
    ips: 400,
    countries: 30,
    total: 50000,
    subResources: 0,
    beacons: 0,
    tiles: 0,
    rpcs: 0,
    complete: true,
    verifiedNames: [],
    ...over,
  });

  test('an unmeasured identity is never cleared — absent evidence is not evidence', () => {
    // A 429 on the reach-paths query, or a 500-group truncation, yields the same zeros as a
    // genuine absence. Clearing on that is how a network full of browsers gets denied.
    const a = adviseBan(scraper({ digestReach: reach({ complete: false }) }));
    expect(a.lever).toBeUndefined();
    expect(a.leverNotes.join(' ')).toContain('could not be fully measured');
  });

  test('map tiles alone prove a browser rendered, even with assets and beacons at zero', () => {
    // Hashed bundles cache for a year and beacons are ad-blocked; tiles and RPCs are not.
    const a = adviseBan(scraper({ digestReach: reach({ tiles: 340 }) }));
    expect(a.lever).toBeUndefined();
    expect(a.leverNotes.join(' ')).toContain('would hit users');
  });

  test('server-fn RPCs alone do the same', () => {
    expect(
      adviseBan(scraper({ digestReach: reach({ rpcs: 900 }) })).lever,
    ).toBeUndefined();
  });

  test('two tells on the same axis are one tell', () => {
    // "zero rendering requests" and "pages but no RPCs" are both entailed by not running the
    // app, so they must not clear a threshold whose whole point is independence.
    const a = adviseBan(
      scraper({
        mix: mixOf([['/company/a', 9060]]),
        ja4: [['t13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb', 9060]], // has ALPN
        shape: shapeOf(series([9060], 10, 144), 10), // one burst, not level
        digestReach: reach({ ips: 1, countries: 1 }),
      }),
    );
    expect(a.verdict).toBe('watch');
  });

  test('a real SPA user browsing three times a day is not automated', () => {
    // The duty-cycle tell measured presence, not levelness, so any repeat visitor tripped it.
    const buckets = series([], 0, 144).map((b, i) => ({
      ...b,
      c: [48, 49, 50, 78, 79, 80, 126, 127, 128].includes(i) ? 30 : 0,
    }));
    const a = adviseBan(
      scraper({
        total: 270,
        mix: mixOf([
          ['/_serverFn/a', 230],
          ['/company/x', 40],
        ]),
        shape: shapeOf(buckets, 10),
        ja4: [['t13d2013h2_aaaaaaaaaaaa_bbbbbbbbbbbb', 270]],
        digestReach: reach({ ips: 1, countries: 1, total: 270 }),
      }),
    );
    // Exact for the same reason: a real session is cleared by a legitimacy blocker, not merely
    // left unbanned, and those are different guarantees.
    expect(a.verdict).toBe('leave');
  });

  test('evidence spanning several fingerprints cannot ban one of them', () => {
    // A co-resident scraper's no-ALPN tell must not deny a browser-negotiating fingerprint.
    const a = adviseBan(
      scraper({
        ja4: [
          ['t13d2013h2_aaaaaaaaaaaa_bbbbbbbbbbbb', 5000],
          ['t13d201100_cccccccccccc_dddddddddddd', 4060],
        ],
      }),
    );
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain('cannot be attributed');
  });

  test('an allow-* rule outside HEADER_GATED_RULES never certifies a caller as first-party', () => {
    // The near-miss this encodes: a rule matching on a caller-controlled User-Agent. Trusting
    // the allow- prefix made every spoofing scraper both invisible and unbannable.
    const a = adviseBan(scraper({ wafRules: [['allow-ua-matched', 400]] }));
    expect(a.blockers.join(' ')).not.toContain('first-party');
    expect(a.verdict).toBe('ban');
  });

  test('a secret-header allow rule certifies first-party when it dominates', () => {
    // Was a small count when written, because the blocker keyed on presence. That is now a
    // minority share and no longer certifies.
    const s = scraper();
    const a = adviseBan(
      scraper({ wafRules: [['allow-ch-stream-revalidate', s.total]] }),
    );
    expect(a.blockers.join(' ')).toContain('first-party');
  });

  test('one token asset fetch does not immunise a scraper forever', () => {
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 9059],
          ['/favicon.svg', 1],
        ]),
      }),
    );
    expect(a.verdict).toBe('ban');
  });

  test('a real browser share of assets still blocks', () => {
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 9000],
          ['/assets/x.js', 400],
        ]),
      }),
    );
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('sub-resource');
  });

  // Regression: the asset axis was share-gated but tiles, RPCs and beacons were gated at `> 0`,
  // so one request of any of them cleared the whole advisory permanently.
  test.each([
    ['server-fn RPC', '/_serverFn/x'],
    ['map tile', '/api/tiles/1/2/3.png'],
    ['analytics beacon', '/_vercel/insights/view'],
  ])('one token %s does not immunise a scraper', (_label, path) => {
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 9059],
          [path, 1],
        ]),
      }),
    );
    expect(a.verdict).toBe('ban');
  });

  test('a real share of RPCs still blocks — the SPA signal is unchanged', () => {
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 9000],
          ['/_serverFn/x', 400],
        ]),
      }),
    );
    expect(a.verdict).toBe('leave');
  });

  // Regression: qualifyLever refused on incomplete reach but blockersFor read a failed query as
  // a measured absence, so a timed-out rule-name lookup silently deleted the first-party blocker
  // while the pane still rendered DENY RECOMMENDED.
  test('a failed query makes the client unjudged, never cleared for a ban', () => {
    const a = adviseBan(scraper({ failedQueries: ['waf rule names'] }));
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain('waf rule names');
    expect(a.leverNotes.join(' ')).toContain('unjudged');
  });

  test('a truncated path sample makes the rendering counts unjudgeable', () => {
    const a = adviseBan(scraper({ mixPartial: true }));
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain('floors');
  });

  test('a failed query does not override a real legitimacy blocker', () => {
    // Legitimacy outranks "cannot tell": a verified bot stays DO NOT DENY either way.
    const a = adviseBan(
      human({
        failedQueries: ['waf rule names'],
        botVerified: [['pass', 100]],
      }),
    );
    expect(a.verdict).toBe('leave');
  });
});

// These two guards protect our own services from our own tooling. ch-stream renders nothing,
// verifies as nothing and does steady volume — indistinguishable from a harvester on every axis
// except the credential it presents. So the ways that credential check can silently stop working
// are worth pinning individually.
describe('first-party protection', () => {
  test('the names are shared with the rule definitions, not copied', () => {
    // rules.ts builds its rules FROM these constants, so a rename cannot desync the two. This
    // asserts the constants are what the advisory matches on — an agreement test would only
    // notice the drift afterwards; sharing one definition makes the drift impossible.
    expect(HEADER_GATED_RULES).toContain(CH_STREAM_REVALIDATE);
    expect(HEADER_GATED_RULES).toContain(DESKTOP_RELEASE_RECORD);
  });

  test('a failed WAF-rule lookup blocks, rather than reading as no credential', () => {
    // An unrun query returns no rules, which looks exactly like a caller holding none. Failing
    // open here would strip first-party protection precisely when the tool is degraded.
    const advice = adviseBan({
      ...scraper(),
      wafRules: [],
      failedQueries: [WAF_RULE_QUERY],
    });
    expect(advice.blockers.join(' ')).toContain('UNKNOWN');
    expect(advice.verdict).not.toBe('ban');
  });

  test('a header-gated rule blocks the ban when it is what the caller does', () => {
    const s = scraper();
    const advice = adviseBan({
      ...s,
      wafRules: [[HEADER_GATED_RULES[0] as string, s.total]],
    });
    expect(advice.blockers.join(' ')).toContain('first-party service');
    expect(advice.verdict).not.toBe('ban');
  });

  test('a handful of hits on a header-gated rule certifies nothing', () => {
    // A certificate a few requests can earn is one an identity collects cheaply and keeps
    // forever. Same rule as the rendering blocker: share, never presence.
    const advice = adviseBan({
      ...scraper(),
      wafRules: [[HEADER_GATED_RULES[0] as string, 1]],
    });
    expect(advice.blockers.join(' ')).not.toContain('first-party service');
    expect(advice.verdict).toBe('ban');
  });

  test('a minority of header-gated traffic is not first-party either', () => {
    const s = scraper();
    const advice = adviseBan({
      ...s,
      wafRules: [[HEADER_GATED_RULES[0] as string, Math.floor(s.total / 2)]],
    });
    expect(advice.blockers.join(' ')).not.toContain('first-party service');
  });

  test('an unrelated failed query does not fabricate the blocker', () => {
    // Fail closed on the lookup that feeds this blocker, not on every degraded query — otherwise
    // any partial profile would certify every caller as first-party and nothing could be banned.
    const advice = adviseBan({
      ...scraper(),
      wafRules: [],
      failedQueries: ['country'],
    });
    expect(advice.blockers.join(' ')).not.toContain('UNKNOWN');
  });
});
