import { describe, expect, test } from 'bun:test';

import {
  MIN_REQUESTS,
  type PathRow,
  bypassPaths,
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
