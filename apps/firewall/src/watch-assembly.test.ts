// The ASSEMBLY, driven without a network.
//
// The decision modules under this path carry 238 tests between them and were right every time.
// `screen`, `findSuspects` and `screenOnce` carried none, because exercising them needed
// production — and every defect found in this package on 2026-08-08 lived in exactly that gap:
// a gate present on the CLI path and missing on the TUI one, four separate times; a truncation
// flag computed and then dropped; a guard applied to the tick but not the reschedule.
//
// These describe traffic as PARAMETERS and let the fakes derive the grouped responses, rather
// than recording API payloads. Recorded rows go stale as dimensions change and would carry real
// fingerprints; parameters carry neither.

import { describe, expect, test } from 'bun:test';

import type { Reach } from './ban-advice';
import type { IpProfile } from './ip-profile';
import { mixOf } from './ip-signals';
import type { Row } from './observability';
import { rollingWindow } from './time-window';
import { type ScreenDeps, findSuspects, screen } from './watch';

const CREDS = { projectId: 'p', teamId: 't', token: 'x' };
const WINDOW = rollingWindow(24, new Date('2026-08-08T12:00:00.000Z'));

/** One client's traffic, said once, in the terms an operator would use to describe it. */
type Client = {
  digest: string;
  requests: number;
  /** Share of requests that are page fetches; the rest are rendering. */
  pageShare: number;
  ips: number;
  ua: string;
  /** Vercel's verification, when it has one. */
  verified?: { name: string };
  category?: string;
  /** A header-gated allow rule this caller matched — the first-party proof. */
  allowRule?: string;
};

const rows = (
  dims: string[],
  make: (c: Client) => Row | Row[] | null,
  cs: Client[],
): Row[] =>
  cs.flatMap((c) => {
    const r = make(c);
    return r === null ? [] : Array.isArray(r) ? r : [r];
  });

/** Grouped responses derived from the clients, matching what `screen` asks for. */
function fakeMetrics(
  clients: Client[],
  opts: { truncateRoutes?: boolean } = {},
) {
  const GROUP_CAP = 500;
  return ((_ctx: unknown, dims: string[]): Promise<{ summary?: Row[] }> => {
    const key = dims.join(',');
    if (key === 'clientJa4Digest,route') {
      const out = rows(
        dims,
        (c) => {
          const pages = Math.round(c.requests * c.pageShare);
          const renders = c.requests - pages;
          return [
            { clientJa4Digest: c.digest, route: '/__server', count_sum: pages },
            ...(renders > 0
              ? [
                  {
                    clientJa4Digest: c.digest,
                    route: '/assets/x.js',
                    count_sum: renders,
                  },
                ]
              : []),
          ];
        },
        clients,
      );
      // Padding to the cap is how a real response signals it may have dropped rows.
      return Promise.resolve({
        summary: opts.truncateRoutes
          ? [
              ...out,
              ...Array.from({ length: GROUP_CAP }, (_, i) => ({
                clientJa4Digest: `t13dpad${String(i).padStart(3, '0')}_a_b`,
                route: '/__server',
                count_sum: 1,
              })),
            ]
          : out,
      });
    }
    if (key === 'clientJa4Digest,botVerified,botName')
      return Promise.resolve({
        summary: rows(
          dims,
          (c) =>
            c.verified
              ? {
                  clientJa4Digest: c.digest,
                  botVerified: 'pass',
                  botName: c.verified.name,
                  count_sum: c.requests,
                }
              : null,
          clients,
        ),
      });
    if (key === 'clientJa4Digest,botCategory')
      return Promise.resolve({
        summary: rows(
          dims,
          (c) =>
            c.category
              ? {
                  clientJa4Digest: c.digest,
                  botCategory: c.category,
                  count_sum: c.requests,
                }
              : null,
          clients,
        ),
      });
    if (key === 'clientJa4Digest,clientUserAgent')
      return Promise.resolve({
        summary: rows(
          dims,
          (c) => ({
            clientJa4Digest: c.digest,
            clientUserAgent: c.ua,
            count_sum: c.requests,
          }),
          clients,
        ),
      });
    if (key === 'wafAction')
      return Promise.resolve({
        summary: [{ wafAction: 'allow', count_sum: 1_000_000 }],
      });
    return Promise.resolve({ summary: [] });
  }) as unknown as ScreenDeps['metrics'];
}

const reach = (c: Client, renders: number): Reach => ({
  label: 'fingerprint (144h)',
  ips: c.ips,
  countries: 1,
  total: c.requests,
  subResources: renders,
  beacons: 0,
  tiles: 0,
  rpcs: 0,
  complete: true,
  verifiedNames: c.verified ? [c.verified.name] : [],
});

/** A profile consistent with the client's own parameters — no second source of truth. */
function fakeProfile(clients: Client[]): ScreenDeps['fetchIpProfile'] {
  return ((_c: unknown, subject: { value: string }) => {
    const c = clients.find((x) => x.digest === subject.value);
    if (!c) throw new Error(`no client for ${subject.value}`);
    const pages = Math.round(c.requests * c.pageShare);
    const renders = c.requests - pages;
    const p: Partial<IpProfile> = {
      subject: { kind: 'ja4', value: c.digest },
      total: c.requests,
      mix: mixOf([
        ['/company/a', pages],
        ...(renders ? ([['/assets/x.js', renders]] as [string, number][]) : []),
      ]),
      shape: {
        bucketMinutes: 60,
        active: 24,
        peak: 40,
        median: 20,
        longestRun: 24,
        sessions: [],
        spanMinutes: 1440,
        concentration: 0.2,
      },
      byJa4: [[c.digest, c.requests]],
      byAsn: [['Hosting Provider', c.requests]],
      byBotVerified: c.verified ? [['pass', c.requests]] : [],
      verifiedBots: c.verified ? [[c.verified.name, c.requests]] : [],
      byWafAction: [['allow', c.requests]],
      byWafRule: c.allowRule ? [[c.allowRule, c.requests]] : [],
      byStatus: [['200', c.requests]],
      byIp: [],
      byCountry: [],
      byBot: [],
      byPath: [],
      byReferrer: [],
      byUserAgent: [],
      digestReach: reach(c, renders),
      asnReach: reach(c, renders),
      windowHours: 24,
      mixPartial: false,
      failedQueries: [],
      errors: [],
      buckets: [],
      tells: [],
    };
    return Promise.resolve(p as IpProfile);
  }) as unknown as ScreenDeps['fetchIpProfile'];
}

const deps = (
  clients: Client[],
  opts?: { truncateRoutes?: boolean },
): ScreenDeps => ({
  metrics: fakeMetrics(clients, opts),
  fetchIpProfile: fakeProfile(clients),
});

/**
 * Runs `fn` at a stated profiling floor.
 *
 * `findSuspects` reads FW_WATCH_MIN_REQUESTS, which throws when absent. Bun auto-loads
 * .env.local, so inheriting it means these pass on this machine and fail in CI — the exact
 * defect that shipped in this package earlier today, from a fixture pinned to a path that
 * existed on one laptop. Stated here, so the tests carry their own assumption.
 */
async function atFloor<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.FW_WATCH_MIN_REQUESTS;
  process.env.FW_WATCH_MIN_REQUESTS = '200';
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.FW_WATCH_MIN_REQUESTS;
    else process.env.FW_WATCH_MIN_REQUESTS = prior;
  }
}

const HARVESTER: Client = {
  digest: 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb',
  requests: 4000,
  pageShare: 1, // nothing but HTML
  ips: 18,
  ua: 'Mozilla/5.0 (compatible; SomeBot/1.0)',
  category: 'browser_impersonation',
};

describe('screen — who becomes a candidate', () => {
  test('an allowlisted verified crawler is not screened', async () => {
    const googlebot: Client = {
      ...HARVESTER,
      digest: 't13dgoog00_cccccccccccc_dddddddddddd',
      ua: 'Googlebot/2.1',
      verified: { name: 'googlebot' },
      category: undefined,
    };
    const out = await screen(
      CREDS,
      WINDOW,
      ['googlebot'],
      [],
      deps([googlebot]),
    );
    expect(out.rows.map((r) => r.digest)).not.toContain(googlebot.digest);
  });

  test('a verified crawler NOT on the allowlist IS screened', async () => {
    // The whole point of the allowlist: verified is not the same as welcome.
    const harvester: Client = {
      ...HARVESTER,
      digest: 't13dshap00_cccccccccccc_dddddddddddd',
      ua: 'Mozilla/5.0 (compatible; SomeBot/1.0)',
      verified: { name: 'somebot' },
      category: undefined,
    };
    const out = await screen(
      CREDS,
      WINDOW,
      ['googlebot'],
      [],
      deps([harvester]),
    );
    expect(out.rows.map((r) => r.digest)).toContain(harvester.digest);
  });

  test('an unread allowlist exempts every verified crawler', async () => {
    // Fail-safe: a config that did not load must not turn Googlebot into a candidate.
    const c: Client = {
      ...HARVESTER,
      verified: { name: 'googlebot' },
      category: undefined,
    };
    const out = await screen(CREDS, WINDOW, undefined, [], deps([c]));
    expect(out.rows).toHaveLength(0);
  });

  test('an identity already denied BY NAME is reported as handled', async () => {
    // Its pre-ban traffic is still in the window, so without this it is re-nominated for a whole
    // window — profiled at ~21 queries, and unattended, a paid investigation to rediscover a ban.
    const out = await screen(
      CREDS,
      WINDOW,
      ['googlebot'],
      ['SomeBot'],
      deps([HARVESTER]),
    );
    expect([...out.handled]).toContain(HARVESTER.digest);
  });

  test('truncation is carried out of the screen, not dropped', async () => {
    const out = await screen(
      CREDS,
      WINDOW,
      ['googlebot'],
      [],
      deps([HARVESTER], { truncateRoutes: true }),
    );
    expect(out.truncated).toBe(true);
  });
});

describe('findSuspects — screen to verdict, end to end', () => {
  test('a raw-HTML enumerator reaches ban', async () => {
    const { findings } = await atFloor(() =>
      findSuspects(
        CREDS,
        WINDOW,
        [],
        ['allow-ch-stream-revalidate'],
        ['googlebot'],
        [],
        deps([HARVESTER]),
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.advice.verdict).toBe('ban');
  });

  test('a first-party caller is left alone however it looks', async () => {
    // ch-stream is server-to-server: no rendering, high volume, one ASN — a harvester on every
    // axis. The header-gated allow rule is the only thing separating them, and it outranks all.
    const chStream: Client = {
      ...HARVESTER,
      digest: 't13dours00_cccccccccccc_dddddddddddd',
      allowRule: 'allow-ch-stream-revalidate',
    };
    const { findings } = await atFloor(() =>
      findSuspects(
        CREDS,
        WINDOW,
        [],
        ['allow-ch-stream-revalidate'],
        ['googlebot'],
        [],
        deps([chStream]),
      ),
    );
    expect(findings[0]?.advice.verdict).toBe('leave');
    expect(findings[0]?.advice.blockers.join(' ')).toContain('first-party');
  });

  test('an unread live config does NOT certify a first-party caller', async () => {
    // trustedAllowRules undefined means "not known", which must not collapse into "qualifies".
    const chStream: Client = {
      ...HARVESTER,
      digest: 't13dours00_cccccccccccc_dddddddddddd',
      allowRule: 'allow-ch-stream-revalidate',
    };
    const { findings } = await atFloor(() =>
      findSuspects(
        CREDS,
        WINDOW,
        [],
        undefined,
        ['googlebot'],
        [],
        deps([chStream]),
      ),
    );
    expect(findings[0]?.advice.blockers.join(' ')).toContain('UNKNOWN');
  });

  test('the allowlist reaches the screen THROUGH findSuspects', async () => {
    // Not the same assertion as testing screen() directly with the right argument. Every
    // divergence found today was a caller failing to FORWARD a gate the callee handled
    // correctly, so the forwarding is the thing that needs its own test.
    const crawler: Client = {
      ...HARVESTER,
      digest: 't13dcrwl00_cccccccccccc_dddddddddddd',
      ua: 'Googlebot/2.1',
      verified: { name: 'googlebot' },
      category: undefined,
    };
    const { findings } = await atFloor(() =>
      findSuspects(
        CREDS,
        WINDOW,
        [],
        ['allow-ch-stream-revalidate'],
        ['googlebot'],
        [],
        deps([crawler]),
      ),
    );
    expect(findings).toHaveLength(0);
  });

  test('a crawler off the allowlist still reaches a verdict through findSuspects', async () => {
    const crawler: Client = {
      ...HARVESTER,
      digest: 't13dcrwl00_cccccccccccc_dddddddddddd',
      ua: 'Mozilla/5.0 (compatible; SomeBot/1.0)',
      verified: { name: 'somebot' },
      category: undefined,
    };
    const { findings } = await atFloor(() =>
      findSuspects(
        CREDS,
        WINDOW,
        [],
        ['allow-ch-stream-revalidate'],
        ['googlebot'],
        [],
        deps([crawler]),
      ),
    );
    expect(findings).toHaveLength(1);
  });

  test('an identity denied by name is never profiled', async () => {
    const { findings } = await atFloor(() =>
      findSuspects(
        CREDS,
        WINDOW,
        [],
        ['allow-ch-stream-revalidate'],
        ['googlebot'],
        ['SomeBot'],
        deps([HARVESTER]),
      ),
    );
    expect(findings).toHaveLength(0);
  });

  test('an identity denied by fingerprint is never profiled', async () => {
    const { findings } = await atFloor(() =>
      findSuspects(
        CREDS,
        WINDOW,
        [HARVESTER.digest],
        ['allow-ch-stream-revalidate'],
        ['googlebot'],
        [],
        deps([HARVESTER]),
      ),
    );
    expect(findings).toHaveLength(0);
  });
});
