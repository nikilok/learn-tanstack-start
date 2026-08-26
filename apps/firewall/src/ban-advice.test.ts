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
  leverCoverage,
  type Reach,
  recommendsAction,
  sustainedByDuration,
  volumeFloor,
  welcomeBots,
  welcomeNames,
  worthInvestigating,
} from './ban-advice';
import { type Mix, dutyCycleOf, mixOf, shapeOf } from './ip-signals';
import { CH_STREAM_REVALIDATE, DESKTOP_RELEASE_RECORD } from './rule-names';

// The duty share these tests judge against. Deliberately NOT the configured value: that one lives
// in .env.local so it stays out of a public repo, and pinning it here would hand it straight back.
// Any share works — the behaviour under test is the comparison, not the number.
const TEST_DUTY = 0.75;

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
    challengedJa4: false,
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
    challengedJa4: false,
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
    const a = adviseBan(scraper({ total: 40, sustainedDuty: TEST_DUTY }));
    expect(a.verdict).toBe('watch');
    expect(a.blockers).toEqual([]);
    expect(a.leverNotes.join(' ')).toContain('under 200');
    // 40 requests cannot be rescued by duration, however long they are spread over: below the
    // flat minimum, "it was here all week" is a statement about nothing.
    expect(a.leverNotes.join(' ')).toContain(
      'too few for how long it was present',
    );
  });

  test('a client pacing itself under the floor is judged on duration instead', () => {
    // The real one this was written for: 899 requests over six days, 217 IPs, zero rendering,
    // present in most hours of every window it was looked at. Under the floor at 144h AND at
    // the API's maximum week, because the floor rises per day and a self-paced client does not
    // — so "widen the window" could never be taken, and it went unprofiled for ten days.
    const a = adviseBan(scraper({ total: 150, sustainedDuty: TEST_DUTY }));
    expect(a.leverNotes.join(' ')).not.toContain('under 200');
    expect(a.verdict).toBe('ban');
  });

  test('an unread duty threshold leaves the volume floor governing alone', () => {
    // The gate is tuned outside the repo, so "not configured" has to mean the pre-gate
    // behaviour rather than a default nobody chose. Same input as above, no threshold.
    const a = adviseBan(scraper({ total: 150 }));
    expect(a.verdict).not.toBe('ban');
    expect(a.leverNotes.join(' ')).toContain('under 200');
    expect(a.leverNotes.join(' ')).toContain(
      'duty threshold could not be read',
    );
  });

  test('duration cannot substitute on a window too short to hold the measure', () => {
    // Ten hourly buckets, every one of them busy. "Present throughout" is what an ordinary
    // visit looks like over ten hours, so the objection stands — and it must say the WINDOW is
    // the problem, not describe a client present in all ten as present in "only" ten.
    const a = adviseBan(
      scraper({
        total: 70,
        sustainedDuty: TEST_DUTY,
        windowMinutes: 600,
        shape: shapeOf(series(Array(10).fill(7), 0, 10), 60),
      }),
    );
    expect(a.leverNotes.join(' ')).toContain('holds only 10 buckets');
  });

  test('a thin client that is genuinely absent most of the window still says so', () => {
    const a = adviseBan(
      scraper({
        total: 137,
        sustainedDuty: TEST_DUTY,
        shape: shapeOf(series(Array(5).fill(27), 0, 24), 60),
      }),
    );
    expect(a.leverNotes.join(' ')).toContain('present in only 5 of its 24');
  });
});

describe('leverCoverage', () => {
  test('an ordinary share is the count over the total', () => {
    expect(leverCoverage('AWS', [['AWS', 50]], 200)).toBe(0.25);
    expect(leverCoverage('AWS', [['AWS', 200]], 200)).toBe(1);
  });

  test('impossible counts refuse rather than resolve', () => {
    // Both are reachable: the breakdown and the total come from different queries, and the
    // total falls back to a route-derived figure that excludes denied requests.
    expect(leverCoverage('AWS', [['AWS', 7783]], 100)).toBeNull();
    expect(leverCoverage('AWS', [['AWS', -5]], 100)).toBeNull();
  });

  test('an absent label or unreadable measure is unknown, not zero', () => {
    expect(leverCoverage('AWS', [['Other', 50]], 200)).toBeNull();
    expect(leverCoverage(undefined, [['AWS', 50]], 200)).toBeNull();
    expect(leverCoverage('AWS', [['AWS', Number.NaN]], 200)).toBeNull();
    expect(leverCoverage('AWS', [['AWS', 50]], 0)).toBeNull();
    expect(leverCoverage('AWS', [['AWS', 50]], Number.NaN)).toBeNull();
  });
});

describe('sustainedByDuration', () => {
  // 24 hourly buckets across a day, the shape the watch loop actually screens on. The duty share
  // is passed explicitly here and everywhere else: it lives in .env.local, and a test that read
  // the environment would pass or fail depending on the operator's current tuning.
  //
  // Deliberately NOT the configured value. Pinning the real one here would put the threshold back
  // in the public repo, which is the whole reason it was moved out.
  const day = (
    active: number,
    total: number,
    duty: number | undefined = TEST_DUTY,
  ) => sustainedByDuration(active, 60, 1440, total, duty);

  test('presence across most of the window stands in for volume', () => {
    expect(day(22, 137)).toBe(true);
    expect(day(18, 137)).toBe(true); // exactly on the threshold
  });

  test('a client seen in a minority of buckets is not sustained', () => {
    expect(day(17, 137)).toBe(false); // one bucket short
    expect(day(1, 137)).toBe(false);
  });

  test('the flat minimum is not negotiable by being around a long time', () => {
    // One request an hour all day clears the duty test and proves nothing.
    expect(day(24, 24)).toBe(false);
    expect(day(24, 49)).toBe(false);
    expect(day(24, 50)).toBe(true);
  });

  test('a window too short to hold the measure never qualifies', () => {
    // 11 buckets is under MIN_PACING_BUCKETS however completely they are filled.
    expect(sustainedByDuration(11, 60, 660, 5000, TEST_DUTY)).toBe(false);
    expect(sustainedByDuration(12, 60, 720, 5000, TEST_DUTY)).toBe(true);
  });

  test('an unconfigured duty threshold refuses everything', () => {
    // The threshold lives in .env.local so it can be absent. Absent must not become a default:
    // that would put the number back in a public repo AND widen what gets judged.
    // Called directly, not through `day`: a default parameter treats an explicit `undefined` as
    // "not passed" and substitutes the default, so the helper cannot express the absent case.
    expect(sustainedByDuration(24, 60, 1440, 5000, undefined)).toBe(false);
    expect(day(24, 5000, Number.NaN)).toBe(false);
    expect(day(24, 5000, 0)).toBe(false);
  });

  test('unreadable inputs refuse rather than resolve', () => {
    // Same NaN hole as the qualifiers: a missing measure must not clear a gate.
    expect(day(Number.NaN, 137)).toBe(false);
    expect(day(22, Number.NaN)).toBe(false);
    expect(sustainedByDuration(22, 0, 1440, 137, TEST_DUTY)).toBe(false);
    expect(sustainedByDuration(22, Number.NaN, 1440, 137, TEST_DUTY)).toBe(
      false,
    );
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
    trustedAllowRules: [CH_STREAM_REVALIDATE],
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
    challengedJa4: false,
    stagedJa4: false,
    alreadyDeniedAsn: false,
    windowMinutes: 1440,
  });

  test('our own cache-invalidation caller is never recommended for a deny', () => {
    const a = adviseBan(chStream());
    expect(a.verdict).toBe('leave');
  });

  test('the matched allow rule is named, and the claim is about the RULE', () => {
    // Deliberately not "it presented our credential" and no longer "it does nothing else".
    // Nothing here sees what was sent; what it knows is which rule matched, and that only means
    // something because the rule itself is one an outsider cannot satisfy.
    const b = adviseBan(chStream()).blockers.join(' ');
    expect(b).toContain('allow-ch-stream-revalidate');
    expect(b).toContain('only our own callers can satisfy');
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
    challengedJa4: false,
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
    // Neither DENY lever survives, which is what this test is for. It now falls through to the
    // recoverable tier instead of to nothing: velia's window renders zero while its fingerprint's
    // own reach renders 1,200, which is the shared-digest shape exactly.
    expect(a.verdict).toBe('challenge');
    expect(a.lever?.tier).toBe('challenge');
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
    // Googlebot rides this NETWORK, not this fingerprint, so the ASN deny is refused while the
    // fingerprint challenge is still available — challenging the digest cannot touch Googlebot.
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
    expect(a.leverNotes.join(' ')).toContain('shared, not one actor');
  });

  test('an unknown network reach is never cleared by default', () => {
    const a = adviseBan(velia({ asnReach: undefined }));
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
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

// Vercel's managed bot protection censors rendering exactly as our own challenge does, and
// `challengedJa4` cannot see it. Measured 2026-08-26 on a fingerprint challenged 234 of 235 times,
// where the advisory offered "zero rendering requests across 235 requests — a raw-HTML fetcher" as
// though the zero were a finding rather than something we caused.
// A referrer is logged BEFORE the WAF acts, so it survives the mitigation that censors rendering.
// Deliberately shares the `rendering` tag: "sends no referrer" and "renders nothing" are one fact —
// this is not a browser — and counting them separately would satisfy the two-axes rule with it.
describe('adviseBan — the referrer tell', () => {
  const withRef = (
    total: number,
    referred: number,
    over: Partial<AdviceInput> = {},
  ): AdviceInput => ({
    total,
    mix: mixOf([['/company/x', total]]),
    shape: shapeOf(series(Array(144).fill(1), 0, 144), 10),
    ja4: [['t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb', total]],
    asns: [['Some ISP', total]],
    botVerified: [],
    wafActions: [['challenge', total]],
    wafRules: [],
    statuses: [],
    referrers: [
      ['', total - referred],
      ...(referred
        ? ([['https://example.test/', referred]] as [string, number][])
        : []),
    ],
    alreadyDeniedJa4: false,
    challengedJa4: false,
    stagedJa4: false,
    alreadyDeniedAsn: false,
    windowMinutes: 1440,
    ...over,
  });

  test('restores the rendering axis when rendering itself is censored', () => {
    // The point of the whole thing: every request was mitigated, so rendering cannot be measured,
    // but the referrer header still can — and it says the same thing.
    const a = adviseBan(withRef(400, 0));
    expect(a.axes).toContain('rendering');
    expect(a.reasons.join(' ')).toContain('no referrer on 400 requests');
  });

  test('does NOT become a second axis', () => {
    // The design decision, pinned. "Renders nothing" and "no referrer" co-occur often enough that
    // counting them apart would let one fact clear the two-axes bar.
    const a = adviseBan(withRef(400, 0, { wafActions: [] }));
    expect(a.axes.filter((x) => x === 'rendering')).toHaveLength(1);
    expect(a.axes).not.toContain('referrer');
  });

  test('a FAILED referrer query is not a measured zero', () => {
    // group() returns [] when the query throws, so a dropped request would otherwise read as
    // "nothing carried a referrer" and hand out the axis on evidence that was never gathered.
    const a = adviseBan(withRef(400, 0, { wafActions: [], referrers: [] }));
    expect(a.reasons.join(' ')).not.toContain('no referrer');
  });

  test('a browsing share of referrers does not fire it', () => {
    // The bar sits below the floor of the browsing population rather than between two overlapping
    // ones, so an ordinary browsing share is nowhere near it.
    expect(adviseBan(withRef(400, 260)).reasons.join(' ')).not.toContain(
      'no referrer',
    );
  });

  test('too little traffic for the claim, so it stays quiet', () => {
    expect(adviseBan(withRef(20, 0)).reasons.join(' ')).not.toContain(
      'no referrer',
    );
  });

  test('an absent referrer list is not a zero share', () => {
    // Unread is not measured-empty — the direction that would invent the tell on every caller
    // that predates the field.
    const a = adviseBan(withRef(400, 0, { referrers: undefined }));
    expect(a.reasons.join(' ')).not.toContain('no referrer');
  });
});

describe('adviseBan — rendering on a mitigated identity', () => {
  const mitigated = (served: number, acted: number): AdviceInput => ({
    total: served + acted,
    mix: mixOf([['/company/x', served + acted]]),
    shape: shapeOf(series(Array(144).fill(1), 0, 144), 10),
    ja4: [['t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb', served + acted]],
    asns: [['Some ISP', served + acted]],
    botVerified: [],
    wafActions: acted ? [['challenge', acted]] : [],
    wafRules: [],
    statuses: [],
    alreadyDeniedJa4: false,
    challengedJa4: false,
    stagedJa4: false,
    alreadyDeniedAsn: false,
    windowMinutes: 1440,
  });

  test('claims censorship only when mitigation actually happened', () => {
    // With no wafActions at all, served === total, and the note read "only 30 of 30 requests were
    // served — the rest were challenged or denied": a sentence contradicting itself about
    // mitigation that never occurred.
    const a = adviseBan(mitigated(30, 0));
    expect(a.leverNotes.join(' ')).not.toContain('rendering not counted');
  });

  test('a fully mitigated identity gets NO rendering axis', () => {
    // It never reached the app, so it cannot have rendered. Counting that as evidence lets our
    // own interstitial argue for the harsher control.
    const a = adviseBan(mitigated(0, 400));
    expect(a.axes).not.toContain('rendering');
    expect(a.reasons.join(' ')).not.toContain('raw-HTML fetcher');
  });

  test('and SAYS the axis was withheld, rather than going quiet', () => {
    const a = adviseBan(mitigated(0, 400));
    expect(a.leverNotes.join(' ')).toContain('rendering not counted');
    expect(a.leverNotes.join(' ')).toContain('That zero is ours');
  });

  test('an identity that was actually SERVED keeps the axis', () => {
    const a = adviseBan(mitigated(400, 0));
    expect(a.axes).toContain('rendering');
  });

  test('a mostly-served identity keeps it — the censorship is partial, not total', () => {
    // Suppressing whenever ANY request was mitigated would delete the axis for nearly everyone.
    // The bar is whether enough traffic was served for the zero to mean something.
    expect(adviseBan(mitigated(400, 200)).axes).toContain('rendering');
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
    challengedJa4: false,
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

  // 404 is the SITE's answer — the client asked for something that is not there.
  test('404s read as probing rather than harvesting', () => {
    const a = adviseBan({ ...prober(), statuses: [['404', 490]] });
    expect(a.leverNotes.join(' ')).toContain('probing rather than harvesting');
  });

  // 429 is OUR answer, and the fixture above had it labelled as probing — a fully mitigated
  // crawler read as a scanner, which is the opposite diagnosis. Measured on a real Googlebot
  // impersonator: 502 of 502 were 429s against 497 valid company pages.
  // 429 is OUR answer, and the fixture above had it labelled as probing — a fully mitigated
  // crawler read as a scanner, the opposite diagnosis. Measured on a real Googlebot impersonator:
  // 502 of 502 were 429s against 497 valid company pages.
  test('429s are not called probing', () => {
    expect(adviseBan(prober()).leverNotes.join(' ')).not.toContain(
      'probing rather than harvesting',
    );
  });

  test('403s are not either — a deny is also our answer, not the site saying "not here"', () => {
    const a = adviseBan({ ...prober(), statuses: [['403', 490]] });
    expect(a.leverNotes.join(' ')).not.toContain(
      'probing rather than harvesting',
    );
  });

  // Attribution comes from wafActions, which knows who answered. A status code does not: the
  // origin can return 403 or 429 just as the WAF can.
  test('the mitigation note comes from the waf action, not the status', () => {
    const a = adviseBan({
      ...prober(),
      statuses: [['403', 490]],
      wafActions: [['log', 490]],
    });
    expect(a.leverNotes.join(' ')).not.toContain('saves the challenge');
  });

  test('a mix still reports probing when the 404s dominate', () => {
    const a = adviseBan({
      ...prober(),
      statuses: [
        ['404', 460],
        ['429', 30],
      ],
    });
    expect(a.leverNotes.join(' ')).toContain('probing rather than harvesting');
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
    // The DENY is what a single tile has to stop. A challenge may still be offered — it is the
    // action whose whole premise is that a rendering client survives it.
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
    expect(a.leverNotes.join(' ')).toContain('would hit users');
  });

  test('server-fn RPCs alone do the same', () => {
    const a = adviseBan(scraper({ digestReach: reach({ rpcs: 900 }) }));
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
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

  test('a secret-header allow rule certifies first-party when the rule is trusted', () => {
    // Was a share test: 400 hits of 9060 certified, then later had to dominate. Both were
    // reconstructions of trust from traffic, needed only while anyone could match the rule.
    const a = adviseBan(
      scraper({
        wafRules: [['allow-ch-stream-revalidate', 3]],
        trustedAllowRules: ['allow-ch-stream-revalidate'],
      }),
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
    // The original guard, with a fixture that is actually a browser. A real session on this
    // site renders many times over the bar, so anything at or above it keeps the
    // blocker, so an ordinary visitor cannot be tuned into a candidate.
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 400],
          ['/assets/x.js', 9000],
        ]),
      }),
    );
    expect(a.verdict).toBe('leave');
    expect(a.blockers.join(' ')).toContain('sub-resource');
  });

  test('rendering that does not scale with pages is not a browser', () => {
    // Supersedes the earlier rule that a bare rendering share blocks. Renders far short of
    // pages means 8600 pages rendered nothing, which no browser does — it is a headless client
    // executing just enough JS to clear a share threshold.
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 9000],
          ['/assets/x.js', 400],
        ]),
      }),
    );
    expect(a.verdict).toBe('ban');
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

  test('an RPC-dominant client still blocks — the SPA direction is unchanged', () => {
    // A real user makes MANY RPCs and FEW page loads. That invariant is untouched.
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 400],
          ['/_serverFn/x', 9000],
        ]),
      }),
    );
    expect(a.verdict).toBe('leave');
  });

  test('a page-dominant client with a token RPC share does not block', () => {
    // The live case, 2026-08-08: a fingerprint carrying oai-searchbot/claudebot/gptbot read the
    // sitemap, walked the company pages, drew ZERO map tiles, and made just enough RPCs to
    // sit far under a real session. The advisory called it "running the app" while its own
    // SPA signal said "fetching HTML directly". Both now agree.
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 9000],
          ['/_serverFn/x', 400],
        ]),
      }),
    );
    expect(a.verdict).toBe('ban');
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

  // A short fn list moves the SAME residual out of `renders` and into `page`, so the
  // proportionality test is wrong on both sides at once. A real session must survive it.
  test('does not let a partial server-fn list unmask a real session', () => {
    const session = {
      total: 300,
      mix: mixOf([
        ['/company/a', 200],
        ['/_serverFn/x', 40],
        ['/assets/app.js', 55],
        ['/tiles/1', 3],
        ['/_vercel/insights/view', 2],
      ]),
    };
    // Attribution trusted: 100 rendering requests against 200 pages fails proportionality, so the
    // browser blocker does not fire.
    const strict = adviseBan(scraper({ ...session, rpcsPartial: false }));
    expect(strict.blockers.join(' ')).not.toContain('running the app');
    // Attribution known incomplete: the same numbers keep the blocker instead of convicting on a
    // residual we cannot stand behind.
    const safe = adviseBan(scraper({ ...session, rpcsPartial: true }));
    expect(safe.blockers.join(' ')).toContain('running the app');
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
    expect(HEADER_GATED_RULES).toContain(CH_STREAM_REVALIDATE);
    expect(HEADER_GATED_RULES).toContain(DESKTOP_RELEASE_RECORD);
  });

  test('a failed WAF-rule lookup blocks, rather than reading as no credential', () => {
    const advice = adviseBan({
      ...scraper(),
      wafRules: [],
      failedQueries: [WAF_RULE_QUERY],
      trustedAllowRules: [CH_STREAM_REVALIDATE],
    });
    expect(advice.blockers.join(' ')).toContain('UNKNOWN');
    expect(advice.verdict).not.toBe('ban');
  });

  test('a hit on a TRUSTED rule certifies a first-party caller', () => {
    const advice = adviseBan({
      ...scraper(),
      wafRules: [[CH_STREAM_REVALIDATE, 3]],
      trustedAllowRules: [CH_STREAM_REVALIDATE],
    });
    expect(advice.blockers.join(' ')).toContain('first-party caller');
    expect(advice.verdict).not.toBe('ban');
  });

  test('a few hits are enough when the rule is trusted', () => {
    // No share threshold any more. A rule only our own callers can satisfy is proof on one hit;
    // reconstructing that from traffic shape was scaffolding for a rule anyone could match.
    const advice = adviseBan({
      ...scraper(),
      wafRules: [[CH_STREAM_REVALIDATE, 1]],
      trustedAllowRules: [CH_STREAM_REVALIDATE],
    });
    expect(advice.blockers.join(' ')).toContain('first-party caller');
  });

  test('a hit on an UNTRUSTED rule certifies nothing, and says why', () => {
    // The rule lost a condition — applied from an older checkout, or edited in the dashboard.
    // It still matches and still looks identical, so the advisory has to say it means nothing.
    const advice = adviseBan({
      ...scraper(),
      wafRules: [[CH_STREAM_REVALIDATE, 9060]],
      trustedAllowRules: [],
    });
    expect(advice.blockers.join(' ')).not.toContain('first-party caller');
    expect(advice.blockers.join(' ')).toContain(
      'no longer requires everything',
    );
    expect(advice.verdict).not.toBe('ban');
  });

  test('an unread live config is UNKNOWN, not untrusted and not trusted', () => {
    // undefined must not collapse into []. One means "we looked and it is weakened", the other
    // means "we never looked" — and only the first is a statement about the rule.
    const advice = adviseBan({
      ...scraper(),
      wafRules: [[CH_STREAM_REVALIDATE, 9060]],
      trustedAllowRules: undefined,
    });
    expect(advice.blockers.join(' ')).toContain('UNKNOWN');
    expect(advice.verdict).not.toBe('ban');
  });

  test('an unrelated failed query does not fabricate the blocker', () => {
    const advice = adviseBan({
      ...scraper(),
      wafRules: [],
      failedQueries: ['country'],
      trustedAllowRules: [CH_STREAM_REVALIDATE],
    });
    expect(advice.blockers.join(' ')).not.toContain('UNKNOWN');
  });
});

// Verification proves a crawler is who it claims. It does not say we want it reading the corpus,
// and an SEO or AI harvester passes it exactly as a search engine does.
describe('welcomeBots / welcomeNames — the verified-bot allowlist', () => {
  const verified: [string, number][] = [
    ['googlebot', 900],
    ['semrush', 400],
  ];

  test('an unread allowlist exempts EVERY verified crawler', () => {
    // The fail-safe direction. A config that failed to load must never turn Googlebot into a ban
    // candidate, so undefined means "as before the list existed", not "nothing is welcome".
    expect(welcomeBots(verified, undefined)).toEqual(verified);
    expect(welcomeNames(['googlebot', 'semrush'], undefined)).toEqual([
      'googlebot',
      'semrush',
    ]);
  });

  test('a read allowlist exempts only the names on it', () => {
    expect(welcomeBots(verified, ['googlebot'])).toEqual([['googlebot', 900]]);
    expect(welcomeNames(['googlebot', 'semrush'], ['googlebot'])).toEqual([
      'googlebot',
    ]);
  });

  test('matching is case-insensitive on both sides', () => {
    // Vercel echoes names lower-case today, but the env file is hand-edited.
    expect(welcomeBots([['GoogleBot', 1]], ['googlebot'])).toHaveLength(1);
    expect(welcomeBots([['googlebot', 1]], ['GOOGLEBOT'])).toHaveLength(1);
  });

  test('an empty allowlist is not the same as an unread one', () => {
    // `[]` is a statement: nothing is welcome. Only `undefined` means "not known".
    expect(welcomeBots(verified, [])).toEqual([]);
  });
});

describe('adviseBan — a non-allowlisted verified crawler is not blocked', () => {
  // A scraper on every axis that also carries a verified crawler name — the case the allowlist
  // exists to separate.
  const verifiedInput = (allowed?: string[]): AdviceInput =>
    scraper({
      botVerified: [['pass', 1300]],
      verifiedBots: [['semrush', 1300]],
      allowedBots: allowed,
    });

  test('an allowlisted crawler still blocks', () => {
    const a = adviseBan(verifiedInput(['semrush']));
    expect(a.blockers.join(' ')).toContain('verified bot');
    expect(a.verdict).toBe('leave');
  });

  test('a non-allowlisted verified crawler loses the blocker', () => {
    // The whole point: verified is not the same as welcome. It still has to earn a ban on the
    // axes, but it is no longer exempt from being looked at.
    const a = adviseBan(verifiedInput(['googlebot']));
    expect(a.blockers.join(' ')).not.toContain('verified bot');
  });

  test('with the list unread it blocks, whatever the name', () => {
    expect(adviseBan(verifiedInput(undefined)).blockers.join(' ')).toContain(
      'verified bot',
    );
  });

  test('falls back to the bare flag when no names were resolved', () => {
    // An older caller, or a bot join that returned nothing. A missing NAME must never strip a
    // real crawler's protection, so the flag alone still blocks.
    const a = adviseBan(
      scraper({
        botVerified: [['pass', 1300]],
        verifiedBots: [],
        allowedBots: ['googlebot'],
      }),
    );
    expect(a.blockers.join(' ')).toContain('verified bot');
  });
});

// The fourth real client, measured 2026-08-12: t13d1516h2_cccccccccccc_111111111111, a stock
// Chrome-family digest carrying real browser sessions over six days AND a distributed
// enumeration in the current window. Deny is unsafe at any evidence level; challenge is the
// lever that separates them. This is the case the advisory previously had no answer for.
describe('the shared fingerprint — challenge, never deny', () => {
  const DIGEST = 't13dsharh2_cccccccccccc_111111111111';
  function sharedFingerprint(over: Partial<AdviceInput> = {}): AdviceInput {
    return {
      total: 417,
      // 416 IPs, one page each, ZERO sub-resources: nothing here renders.
      mix: mixOf([
        ['/company/a', 217],
        ['/company/b', 196],
        ['/sitemap.xml', 4],
      ]),
      shape: shapeOf(series(Array(144).fill(3), 0, 144), 10),
      ja4: [[DIGEST, 417]],
      asns: [['Saudi Telecom Company JSC', 417]],
      botVerified: [],
      wafActions: [
        ['allow', 217],
        ['challenge', 200],
      ],
      wafRules: [],
      statuses: [['200', 107]],
      // The >= 6 day reach DOES render — that is the whole point. Real browsers live here.
      digestReach: {
        label: DIGEST,
        ips: 489,
        countries: 80,
        total: 650,
        subResources: 118,
        beacons: 16,
        tiles: 18,
        rpcs: 6,
        complete: true,
        verifiedNames: [],
      },
      asnReach: {
        label: 'Saudi Telecom Company JSC',
        ips: 400,
        countries: 1,
        total: 5000,
        subResources: 900,
        beacons: 400,
        tiles: 40,
        rpcs: 100,
        complete: true,
        verifiedNames: [],
      },
      alreadyDeniedJa4: false,
      challengedJa4: false,
      stagedJa4: false,
      alreadyDeniedAsn: false,
      windowMinutes: 1440,
      ...over,
    };
  }

  test('recommends the recoverable tier, targeting FW_CHALLENGE_JA4', () => {
    const a = adviseBan(sharedFingerprint());
    expect(a.verdict).toBe('challenge');
    expect(a.lever).toEqual({
      kind: 'ja4',
      value: DIGEST,
      why: expect.stringContaining('SHARED'),
      tier: 'challenge',
    });
  });

  test('never recommends a deny for it, at any point', () => {
    const a = adviseBan(sharedFingerprint());
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
    // And it says why the deny was refused, which is the half an operator acts on.
    expect(a.leverNotes.join(' ')).toContain('a blanket deny would hit users');
  });

  test('rendering in the CURRENT window drops it back to watch', () => {
    // A challenge only stops a client that cannot run JavaScript. One that renders might solve
    // it, and then the interstitial is a tax on real users for nothing.
    const a = adviseBan(
      sharedFingerprint({
        mix: mixOf([
          ['/company/a', 217],
          ['/company/b', 196],
          ['/api/tiles/x', 30],
        ]),
      }),
    );
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain(
      'tax real users and catch nothing',
    );
  });

  test('an incompletely measured reach is not softened into a challenge', () => {
    const a = adviseBan(
      sharedFingerprint({
        digestReach: {
          ...sharedFingerprint().digestReach!,
          complete: false,
        },
      }),
    );
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain('unknown escalates to a human');
  });

  test('a verified crawler we want blocks it exactly as hard as a deny', () => {
    // Googlebot cannot answer a challenge either, so "recoverable" must not soften this.
    const a = adviseBan(
      sharedFingerprint({
        digestReach: {
          ...sharedFingerprint().digestReach!,
          verifiedNames: ['googlebot'],
        },
        allowedBots: ['googlebot'],
      }),
    );
    expect(a.verdict).toBe('leave');
    expect(a.lever).toBeUndefined();
  });

  test('too little traffic to judge still outranks it', () => {
    const a = adviseBan(sharedFingerprint({ total: 10 }));
    expect(a.verdict).toBe('watch');
  });

  test('the deniable scraper is untouched — the new branch does not steal it', () => {
    const a = adviseBan(scraper());
    expect(a.verdict).toBe('ban');
    expect(a.lever?.tier).toBe('deny');
  });
});

describe('recommendsAction', () => {
  test('covers both tiers that name a lever', () => {
    expect(recommendsAction('ban')).toBe(true);
    expect(recommendsAction('challenge')).toBe(true);
  });

  test('and nothing else', () => {
    for (const v of ['watch', 'staged', 'already', 'leave', ''])
      expect(recommendsAction(v)).toBe(false);
  });
});

// Found by an adversarial review of the challenge tier shipped 2026-08-12, not by these tests.
//
// The loop: a browser that meets our interstitial and does not solve it never fetches a single
// sub-resource, so it contributes zero rendering requests. Over a >= 6 day reach the pre-challenge
// evidence ages out, the reach reads a clean zero, and the deny clears — on an absence this tool
// manufactured. Worse, that zero only appears when the challenge is FAILING for real browsers, so
// the advisory would recommend the harsher control in exactly the case where the softer one is
// already hurting people.
describe('a challenged fingerprint cannot clear its own deny', () => {
  // The reach a challenge produces after the browsers have been silenced: spotless.
  const censored = (over = {}) => ({
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
    ...over,
  });

  test('the same evidence bans when NOT challenged', () => {
    // The control. Without this the test below could pass for the wrong reason.
    const a = adviseBan(scraper({ digestReach: censored() }));
    expect(a.verdict).toBe('ban');
    expect(a.lever?.tier).toBe('deny');
  });

  test('and does NOT ban once we are challenging it', () => {
    const a = adviseBan(
      scraper({ digestReach: censored(), challengedJa4: true }),
    );
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
  });

  test('and says the zero is one we caused, not one we measured', () => {
    const a = adviseBan(
      scraper({ digestReach: censored(), challengedJa4: true }),
    );
    expect(a.leverNotes.join(' ')).toContain('FW_CHALLENGE_JA4');
    expect(a.leverNotes.join(' ')).toContain('one this tool caused');
    expect(a.leverNotes.join(' ')).toContain('Lift the challenge');
  });

  test('the ASN lever is still reachable — the taint is on the fingerprint only', () => {
    // A challenge on the digest says nothing about a hosting network, and killing both levers
    // would make challenging an identity a way to make it permanently unactionable.
    //
    // `asns` names the same network as the reach because in production it IS the same row —
    // ip-profile builds asnReach.label from byAsn[0]. Leaving them mismatched here made the
    // fixture describe a client whose top network carries none of its traffic, and the coverage
    // guard below refuses that, correctly.
    const asn = 'velia.net Internetdienste GmbH';
    const a = adviseBan(
      scraper({
        digestReach: censored(),
        challengedJa4: true,
        asns: [[asn, 9060]],
        asnReach: censored({ label: asn, ips: 4 }),
      }),
    );
    expect(a.verdict).toBe('ban');
    expect(a.lever?.kind).toBe('asn');
  });

  test('a network carrying a sliver of the client is not offered as a lever', () => {
    // The vacuous pass, one layer above the volume floor. A client spread across a proxy pool
    // has an arbitrary top ASN, and it clears the reach test honestly: nothing rendered, because
    // barely anything happened. Offering it denies a telecom's whole range to stop a fraction.
    const asn = 'Earthlink Telecommunications DMCC';
    const a = adviseBan(
      scraper({
        digestReach: censored(),
        challengedJa4: true,
        asns: [[asn, 53]], // 53 of 9060 — the flat tail of a 101-country pool
        asnReach: censored({ label: asn, ips: 53, total: 53 }),
      }),
    );
    expect(a.verdict).not.toBe('ban');
    expect(a.leverNotes.join(' ')).toContain('only 1%');
    expect(a.leverNotes.join(' ')).toContain('the wrong trade');
  });

  test('an ASN count larger than the identity is impossible, so it is refused', () => {
    // `total` and `asns` come from DIFFERENT queries, and `total` falls back to a route-derived
    // figure when the status query degrades to []. Routes exclude denied requests while an ASN
    // grouping counts them, so a heavily-denied identity yields a count above its own total.
    // That ratio is >1, which cleared the coverage bar exactly as a strong majority does — and
    // silently, because the coverage note only prints when it refuses.
    const asn = 'Some Hosting Ltd';
    const a = adviseBan(
      scraper({
        digestReach: censored(),
        challengedJa4: true,
        asns: [[asn, 20_000]], // against a total of 9060
        asnReach: censored({ label: asn, ips: 40 }),
      }),
    );
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.kind).not.toBe('asn');
    expect(a.leverNotes.join(' ')).toContain('an unknown share');
  });

  test('an ASN whose share cannot be computed is refused, not assumed', () => {
    const a = adviseBan(
      scraper({
        digestReach: censored(),
        challengedJa4: true,
        asns: [],
        asnReach: censored({ label: 'Somewhere Ltd', ips: 60 }),
      }),
    );
    expect(a.verdict).not.toBe('ban');
    expect(a.leverNotes.join(' ')).toContain('an unknown share');
  });

  test('a genuinely rendering reach is refused for its own reason, not this one', () => {
    // The note must still name the browsers, or an operator reads "lift the challenge" and does.
    const a = adviseBan(
      scraper({
        digestReach: censored({ tiles: 900 }),
        challengedJa4: true,
      }),
    );
    expect(a.leverNotes.join(' ')).toContain('real browsers render from it');
    expect(a.leverNotes.join(' ')).not.toContain('Lift the challenge');
  });
});

// Found live 2026-08-13: the TUI offered an ASN lever for `Byteplus Pte. Ltd.` on TWO requests
// site-wide over six days. It cleared because zero of two rendered — a check reporting agreement
// having tested nothing, which is this codebase's second-most-common defect after error-path
// aliasing. The subject's volume had been floored since the beginning; the reach never was.
describe('a reach too small to judge does not clear a lever', () => {
  const tiny = {
    label: 'Byteplus Pte. Ltd.',
    ips: 2,
    countries: 1,
    total: 2,
    subResources: 0,
    beacons: 0,
    tiles: 0,
    rpcs: 0,
    complete: true,
    verifiedNames: [],
  };

  test('a 2-request network is NOT offered as a DENY lever', () => {
    const a = adviseBan(scraper({ digestReach: tiny, asnReach: tiny }));
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
  });

  test('it says the evidence is too thin, not that the network is clean', () => {
    // The distinction an operator acts on: "not cleared" must not read as "condemned" either.
    const notes = adviseBan(
      scraper({ digestReach: tiny, asnReach: tiny }),
    ).leverNotes.join(' ');
    expect(notes).toContain('only 2 requests across the whole reach');
    expect(notes).toContain('Not cleared, and not condemned either');
  });

  test('the same network WITH enough traffic and no rendering still clears', () => {
    // The control. Without it this could pass because the fixture stopped qualifying at all.
    const big = { ...tiny, total: 50000, ips: 4 };
    const a = adviseBan(scraper({ digestReach: big, asnReach: big }));
    expect(a.verdict).toBe('ban');
    expect(a.lever?.tier).toBe('deny');
  });

  test('the bar does not move with the window on screen', () => {
    // Reach is >= 6 days whatever is displayed, so a 20-minute view must not buy a cheaper reach
    // test than a six-day one. Same verdict at every window.
    const thin = { ...tiny, total: 12, ips: 3 };
    for (const windowMinutes of [20, 1440, 8640])
      expect(
        adviseBan(
          scraper({
            digestReach: thin,
            asnReach: thin,
            windowMinutes,
            total: 9060,
          }),
        ).lever?.tier,
      ).not.toBe('deny');
  });

  test('the bar is low enough to still act on a real low-volume scanner', () => {
    // A 490-request backdoor scanner over 6 days is thin but judgeable — a browser renders many
    // requests per page, so hundreds with zero sub-resources IS browser-free. An earlier version
    // of this floor scaled to the reach span, landed far higher, and refused it.
    const scanner = { ...tiny, total: 490, ips: 8 };
    const a = adviseBan(scraper({ digestReach: scanner, asnReach: scanner }));
    expect(a.verdict).toBe('ban');
    expect(a.lever?.tier).toBe('deny');
  });
});

// CodeRabbit, 2026-08-13: the challenge tier had no `already` state, so a digest whose challenge
// was live still read as CHALLENGE RECOMMENDED — the deny tier's own reason for having one.
describe('an already-challenged fingerprint reads as handled, not as a fresh recommendation', () => {
  const shared = (over: Partial<AdviceInput> = {}) =>
    scraper({
      mix: mixOf([
        ['/company/a', 9000],
        ['/sitemap-1.xml', 60],
      ]),
      digestReach: {
        label: 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb',
        ips: 413,
        countries: 205,
        total: 171751,
        subResources: 900,
        beacons: 40,
        tiles: 10,
        rpcs: 5,
        complete: true,
        verifiedNames: [],
      },
      ...over,
    });

  test('unchallenged, it recommends the challenge', () => {
    // The control: without it the assertion below could pass for the wrong reason.
    expect(adviseBan(shared()).verdict).toBe('challenge');
  });

  test('challenged, it reports handled instead', () => {
    const a = adviseBan(shared({ challengedJa4: true }));
    expect(a.verdict).toBe('already');
    expect(a.blockers.join(' ')).toContain('already in FW_CHALLENGE_JA4');
  });

  test('and carries the tier, so the view cannot claim it is DENIED', () => {
    // 'ALREADY DENIED' on something only being interstitialed reads as handled while the traffic
    // is still served — the more costly way to be wrong.
    expect(adviseBan(shared({ challengedJa4: true })).lever?.tier).toBe(
      'challenge',
    );
  });
});

// The gate that decides whether an unattended run pays for an agent. Changed 2026-08-13 from
// `verdict === 'ban'` to two independent axes, so the case that took a human most of a night —
// scraper-shaped, every lever shared — is adjudicated automatically instead of sitting in `watch`.
describe('worthInvestigating', () => {
  test('the deniable scraper qualifies', () => {
    expect(worthInvestigating(adviseBan(scraper()))).toBe(true);
  });

  test('and so does the SHARED fingerprint, which never reached an agent before', () => {
    const a = adviseBan(
      scraper({
        mix: mixOf([
          ['/company/a', 9000],
          ['/sitemap-1.xml', 60],
        ]),
        digestReach: {
          label: 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb',
          ips: 413,
          countries: 205,
          total: 171751,
          subResources: 900,
          beacons: 40,
          tiles: 10,
          rpcs: 5,
          complete: true,
          verifiedNames: [],
        },
      }),
    );
    expect(a.verdict).not.toBe('ban');
    expect(worthInvestigating(a)).toBe(true);
  });

  test('a real user does not', () => {
    expect(worthInvestigating(adviseBan(human()))).toBe(false);
  });

  test('a low-volume identity still scores axes — the volume gate is upstream, not here', () => {
    // Worth pinning because it corrects the obvious assumption. The axes fire regardless of
    // volume; `unjudgeableFor` is what downgrades the verdict. In the watch loop this case cannot
    // reach the gate at all — `worthProfiling` applies `screenFloor`, which is never below the
    // advisory's own floor, so nothing this thin ever becomes a finding. And where the evidence is
    // unmeasurable rather than thin (a failed query, a truncated sample), an agent is exactly the
    // right spend: it re-queries live and can get the answer the screen could not.
    const a = adviseBan(scraper({ total: 40 }));
    expect(a.verdict).toBe('watch');
    expect(a.axes.length).toBeGreaterThanOrEqual(2);
    expect(worthInvestigating(a)).toBe(true);
  });

  test('one axis is never enough, however loud', () => {
    expect(worthInvestigating({ verdict: 'watch', axes: ['rendering'] })).toBe(
      false,
    );
    expect(worthInvestigating({ verdict: 'watch', axes: [] })).toBe(false);
  });
});

// Both found by the PR review on 2026-08-13, after a local CLI pass reported nothing. Each is a
// TWIN-MISS: a guard added to one function and not to the sibling that needed it just as much.
describe('review regressions — the twin that got missed', () => {
  test('a reach too thin for a deny is too thin for a CHALLENGE as well', () => {
    // The floor went into qualifyLever and not qualifyChallenge, and the path is reachable: the
    // deny is refused on the floor, then falls straight through to the recoverable tier. The
    // "recoverable, so a lower bar is fine" argument does not survive the note it prints, which
    // claims the fingerprint is SHARED — the only reason to prefer a challenge over a deny.
    const thin = {
      label: 'x',
      ips: 2,
      countries: 1,
      total: 2,
      subResources: 0,
      beacons: 0,
      tiles: 0,
      rpcs: 0,
      complete: true,
      verifiedNames: [],
    };
    const a = adviseBan(scraper({ digestReach: thin, asnReach: thin }));
    expect(a.verdict).not.toBe('challenge');
    expect(a.lever).toBeUndefined();
    expect(a.leverNotes.join(' ')).toContain('too little to call it shared');
  });

  test('a BLOCKED identity is never worth an agent, however many axes it scores', () => {
    // Axes are filled on every path, including `leave`. A verified crawler still scores rendering
    // and spread before blockersFor clears it — so reading axes alone wakes a paid agent on
    // Googlebot, and does it every tick.
    const a = adviseBan(scraper({ botVerified: [['pass', 500]] }));
    expect(a.verdict).toBe('leave');
    expect(a.axes.length).toBeGreaterThanOrEqual(2);
    expect(worthInvestigating(a)).toBe(false);
  });

  test('nor is one already handled or staged', () => {
    for (const v of ['already', 'staged'] as const)
      expect(
        worthInvestigating({ verdict: v, axes: ['rendering', 'spread'] }),
      ).toBe(false);
  });
});

// PR review, 2026-08-13. NaN defeats every comparison in BOTH directions — `NaN < floor` is false
// so it walks past a lower bound, `NaN > 0` is false so it walks past an upper bound — and arrives
// looking like a measured clean value. `autoBanRefusal` has guarded this since it shipped; the
// qualifiers did not, and a wrongly CLEARED lever is the more expensive way to be wrong.
describe('unmeasured metrics never clear a lever', () => {
  const reach = (over: Partial<Reach> = {}): Reach => ({
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

  test('CONTROL — the same reach with real numbers still bans', () => {
    // Without this, every assertion below could pass because the fixture stopped qualifying.
    const a = adviseBan(scraper({ digestReach: reach(), asnReach: reach() }));
    expect(a.verdict).toBe('ban');
    expect(a.lever?.tier).toBe('deny');
  });

  test('a NaN reach total does not clear the DENY', () => {
    const a = adviseBan(
      scraper({
        digestReach: reach({ total: Number.NaN }),
        asnReach: reach({ total: Number.NaN }),
      }),
    );
    expect(a.verdict).not.toBe('ban');
    expect(a.lever?.tier).not.toBe('deny');
    expect(a.leverNotes.join(' ')).toContain('not a usable number');
  });

  test('ONE unreadable rendering field poisons the sum and still does not clear', () => {
    // browserEvidence adds four fields, so a single NaN makes the whole total NaN — and then
    // `browsery > 0` is false, which is exactly how "no browser has ever rendered" gets asserted
    // about data nobody read.
    for (const f of ['subResources', 'beacons', 'tiles', 'rpcs'] as const) {
      const a = adviseBan(
        scraper({
          digestReach: reach({ [f]: Number.NaN }),
          asnReach: reach({ [f]: Number.NaN }),
        }),
      );
      expect(a.verdict).not.toBe('ban');
      expect(a.lever?.tier).not.toBe('deny');
    }
  });

  test('a negative count is not a measurement either', () => {
    const a = adviseBan(
      scraper({
        digestReach: reach({ ips: -1 }),
        asnReach: reach({ ips: -1 }),
      }),
    );
    expect(a.lever?.tier).not.toBe('deny');
  });

  test('nor does an unmeasured reach fall through to a CHALLENGE', () => {
    // The finding as reported: the deny is refused, and without the guard qualifyChallenge then
    // returns ok on the same unreadable data.
    const a = adviseBan(
      scraper({
        mix: mixOf([['/company/a', 9060]]),
        digestReach: reach({ total: Number.NaN }),
        asnReach: reach({ total: Number.NaN }),
      }),
    );
    expect(a.verdict).not.toBe('challenge');
    expect(a.verdict).not.toBe('ban');
    expect(a.lever).toBeUndefined();
  });

  test('an unreadable WINDOW total is unjudgeable, not "above the floor"', () => {
    // NaN does not fall under the volume floor, so it used to clear the gate silently and the
    // identity was judged on a number nobody had.
    const a = adviseBan(scraper({ total: Number.NaN }));
    expect(a.verdict).toBe('watch');
    expect(a.leverNotes.join(' ')).toContain('could not be read');
  });
});

// The advisory half of the same finding: the fact has to leave adviseBan on every path, or the
// view has nothing to render.
describe('challengeLive leaves the advisory whatever the verdict', () => {
  test('a challenged digest that cannot qualify still reports the live challenge', () => {
    // Renders in the window, so qualifyChallenge refuses and this falls through to `watch` —
    // the exact path where the fact used to disappear.
    const a = adviseBan(
      scraper({
        challengedJa4: true,
        mix: mixOf([
          ['/company/a', 9000],
          ['/api/tiles/x', 60],
        ]),
        digestReach: {
          label: 'x',
          ips: 413,
          countries: 205,
          total: 171751,
          subResources: 900,
          beacons: 40,
          tiles: 10,
          rpcs: 5,
          complete: true,
          verifiedNames: [],
        },
      }),
    );
    expect(a.verdict).toBe('watch');
    expect(a.challengeLive).toBe(true);
  });

  test('CONTROL — an unchallenged one reports false, not undefined', () => {
    const a = adviseBan(scraper());
    expect(a.challengeLive).toBe(false);
  });

  test('it survives a legitimacy blocker too', () => {
    const a = adviseBan(
      scraper({ challengedJa4: true, botVerified: [['pass', 500]] }),
    );
    expect(a.verdict).toBe('leave');
    expect(a.challengeLive).toBe(true);
  });
});
