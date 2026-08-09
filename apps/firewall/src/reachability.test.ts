import { describe, expect, test } from 'bun:test';

import {
  MIN_REQUESTS,
  type PathRow,
  blockedFirstParty,
  bypassPaths,
  reachabilityFindings,
  rollUp,
  unreachable,
} from './reachability.ts';
import type { Rule } from './rules.ts';

const rule = (
  name: string,
  action: 'bypass' | 'deny',
  paths: string[],
): Rule => ({
  name,
  description: name,
  active: true,
  conditionGroup: paths.map((value) => ({
    conditions: [{ type: 'path' as const, op: 'pre' as const, value }],
  })),
  action: { mitigate: { action } },
});

describe('bypassPaths', () => {
  test('collects the paths our bypasses exempt', () => {
    expect(
      bypassPaths([
        rule('allow-a', 'bypass', ['/downloads/latest/']),
        rule('allow-b', 'bypass', ['/robots.txt', '/llms.txt']),
      ]).sort(),
    ).toEqual(['/downloads/latest/', '/llms.txt', '/robots.txt']);
  });

  test('ignores rules that are not bypasses', () => {
    // A deny rule's paths are the opposite question: nothing getting through is the point.
    expect(bypassPaths([rule('deny-x', 'deny', ['/anything'])])).toEqual([]);
  });

  test('deduplicates a path named by more than one rule', () => {
    expect(
      bypassPaths([
        rule('allow-a', 'bypass', ['/p']),
        rule('allow-b', 'bypass', ['/p']),
      ]),
    ).toEqual(['/p']);
  });
});

describe('rollUp', () => {
  const rows: PathRow[] = [
    { path: '/downloads/latest/latest.yml', action: 'challenge', count: 21 },
    {
      path: '/downloads/latest/latest-mac.yml',
      action: 'challenge',
      count: 36,
    },
    { path: '/company/abc', action: 'allow', count: 900 },
  ];

  test('sums by prefix, not by exact path', () => {
    // The rule matches a prefix, so a per-path row alone would never reach the threshold.
    expect(rollUp(rows, ['/downloads/latest/'])).toEqual([
      { prefix: '/downloads/latest/', served: 0, mitigated: 57 },
    ]);
  });

  test('traffic outside the prefix is somebody else’s', () => {
    expect(rollUp(rows, ['/downloads/latest/'])[0]!.served).toBe(0);
  });

  test('allow, bypass and log all count as served', () => {
    const r = rollUp(
      [
        { path: '/p/a', action: 'allow', count: 1 },
        { path: '/p/b', action: 'bypass', count: 2 },
        { path: '/p/c', action: 'log', count: 4 },
        { path: '/p/d', action: 'deny', count: 8 },
      ],
      ['/p/'],
    )[0]!;
    expect(r.served).toBe(7);
    expect(r.mitigated).toBe(8);
  });
});

describe('unreachable', () => {
  test('reports a prefix whose traffic was entirely mitigated', () => {
    // The real one this pins: the updater feed, 57 challenged and 0 served over seven days,
    // with nothing anywhere reporting it.
    const out = unreachable([
      { prefix: '/downloads/latest/', served: 0, mitigated: 57 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('/downloads/latest/');
    expect(out[0]).toContain('57');
  });

  test('a path that is being served is fine however much is mitigated beside it', () => {
    // A scanner hitting a header-gated path without the header is challenged and should be.
    expect(
      unreachable([{ prefix: '/api/revalidate', served: 12, mitigated: 400 }]),
    ).toEqual([]);
  });

  test('quiet is not evidence', () => {
    // Nobody asked for it in this window, so the window says nothing about it either way.
    expect(
      unreachable([{ prefix: '/downloads/latest/', served: 0, mitigated: 0 }]),
    ).toEqual([]);
  });

  test('a stray hit is not an outage', () => {
    expect(
      unreachable([{ prefix: '/p', served: 0, mitigated: MIN_REQUESTS - 1 }]),
    ).toEqual([]);
    expect(
      unreachable([{ prefix: '/p', served: 0, mitigated: MIN_REQUESTS }]),
    ).toHaveLength(1);
  });

  test('a caller-supplied floor is still held to at least one request', () => {
    // minRequests 0 would make every quiet prefix an outage.
    expect(unreachable([{ prefix: '/p', served: 0, mitigated: 0 }], 0)).toEqual(
      [],
    );
  });
});

describe('blockedFirstParty', () => {
  const P = ['/downloads/latest/'];
  const row = (
    agent: string,
    action: string,
    count: number,
    path = '/downloads/latest/latest.yml',
  ) => ({ path, agent, action, count });

  test('the case unreachable cannot see: served traffic beside a blocked client', () => {
    // The real shape, measured live: 27 served on the prefix and 4 updater requests
    // challenged. unreachable() reads that as quiet, because something got through.
    const rows = [
      row('electron-builder', 'bypass', 27),
      row('electron-builder', 'challenge', 4),
    ];
    expect(unreachable(rollUp(rows, P))).toEqual([]);
    const out = blockedFirstParty(rows, P);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('electron-builder');
    expect(out[0]).toContain('4');
  });

  test('the app itself counts, version and all', () => {
    // Its UA carries a version, so the match has to be a substring.
    const out = blockedFirstParty(
      [row('Mozilla/5.0 ... SponsorSearchDesktop/0.5.0', 'deny', 3)],
      P,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('SponsorSearchDesktop');
  });

  test('a third-party client being refused is not our problem', () => {
    expect(blockedFirstParty([row('SomeScraper/1.0', 'deny', 500)], P)).toEqual(
      [],
    );
  });

  test('served first-party traffic raises nothing', () => {
    expect(
      blockedFirstParty(
        [row('electron-builder', 'bypass', 40), row('x', 'allow', 9)],
        P,
      ),
    ).toEqual([]);
  });

  test('only on paths we exempt', () => {
    // Our own app being challenged on the site itself is the challenge tier working.
    expect(
      blockedFirstParty(
        [row('SponsorSearchDesktop/0.5.0', 'challenge', 20, '/company/abc')],
        P,
      ),
    ).toEqual([]);
  });

  test('counts are summed per client and action, not per path', () => {
    const out = blockedFirstParty(
      [
        row(
          'electron-builder',
          'challenge',
          21,
          '/downloads/latest/latest.yml',
        ),
        row(
          'electron-builder',
          'challenge',
          36,
          '/downloads/latest/latest-mac.yml',
        ),
      ],
      P,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('57');
  });

  test('a floor is available for spoof noise, and holds at one', () => {
    const rows = [row('electron-builder', 'deny', 2)];
    expect(blockedFirstParty(rows, P, { min: 5 })).toEqual([]);
    expect(blockedFirstParty(rows, P, { min: 0 })).toHaveLength(1);
  });
});

describe('bypassPaths — branches that are not path exemptions', () => {
  const withGroups = (
    name: string,
    active: boolean,
    groups: Rule['conditionGroup'],
  ): Rule => ({
    name,
    description: name,
    active,
    conditionGroup: groups,
    action: { mitigate: { action: 'bypass' } },
  });

  test('an inactive bypass is not exempting anything', () => {
    // Mitigation on a rule the operator switched off is their call, not a fault.
    expect(
      bypassPaths([
        withGroups('allow-off', false, [
          { conditions: [{ type: 'path', op: 'pre', value: '/p/' }] },
        ]),
      ]),
    ).toEqual([]);
  });

  test('a header-gated bypass is skipped: it mitigates by design', () => {
    // The real one this pins: /api/revalidate and /api/releases challenge a caller with no
    // secret, which is the gate working. Monitoring them would alarm on that.
    expect(
      bypassPaths([
        withGroups('allow-gated', true, [
          {
            conditions: [
              { type: 'path', op: 'eq', value: '/api/revalidate' },
              { type: 'header', op: 'ex', key: 'x-revalidate-secret' },
            ],
          },
        ]),
      ]),
    ).toEqual([]);
  });

  test('a rule mixing both keeps only its path-only branch', () => {
    expect(
      bypassPaths([
        withGroups('allow-mixed', true, [
          { conditions: [{ type: 'path', op: 'pre', value: '/open/' }] },
          {
            conditions: [
              { type: 'path', op: 'eq', value: '/gated' },
              { type: 'header', op: 'ex', key: 'x-secret' },
            ],
          },
        ]),
      ]),
    ).toEqual(['/open/']);
  });

  // Deliberately no assertion against the real `rules` array: rules.ts reads required
  // ceilings from the environment at import, by design, so importing it from a test either
  // throws or races another file that already has. The shapes it can produce are covered
  // above; a guard over the live rules belongs in rule-integrity, not here.
});

describe('reachabilityFindings', () => {
  const rows = [
    {
      path: '/downloads/latest/latest.yml',
      agent: 'electron-builder',
      action: 'challenge',
      count: 57,
    },
  ];

  test('a complete sample answers', () => {
    const r = reachabilityFindings(rows, ['/downloads/latest/'], {
      truncated: false,
    });
    expect(r.error).toBeUndefined();
    expect(r.findings.length).toBeGreaterThan(0);
  });

  test('a capped sample refuses to answer, and says so', () => {
    // Dropped served rows invent an outage; dropped mitigated rows hide one. Neither
    // verdict is available, so this reports that rather than guessing.
    const r = reachabilityFindings(rows, ['/downloads/latest/'], {
      truncated: true,
    });
    expect(r.findings).toEqual([]);
    expect(r.error).toContain('group cap');
  });
});
