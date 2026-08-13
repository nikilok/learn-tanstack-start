// A zero in this map reads as "safe to retire" about a ban. That is stated at the top of the
// module it tests, and it is why an entry must never be zero for a reason other than no traffic.

import { afterEach, describe, expect, mock, test } from 'bun:test';

const DIGEST = 't13d1516h2_8daaf6152771_b0da82dd1658';
const CREDS = { projectId: 'p', teamId: 't', token: 'k' };

/** Load fetchDenyActivity with `metrics` returning `summary`. */
async function withSummary(summary: unknown[]) {
  const real = await import('./observability');
  mock.module('./observability', () => ({
    ...real,
    metrics: async () => ({ summary }),
  }));
  const { fetchDenyActivity } = await import('./denylist-data');
  return fetchDenyActivity(CREDS, 144, [DIGEST]);
}

afterEach(() => {
  mock.restore();
});

describe('fetchDenyActivity', () => {
  test('counts the traffic a denied digest saw', async () => {
    const { activity } = await withSummary([
      { clientJa4Digest: DIGEST, wafAction: 'deny', count: 40 },
    ]);
    expect(activity.get(DIGEST)).toEqual({ requests: 40, denied: 40 });
  });

  // The API can return a digest upper-cased. Keyed as-is, the row created a SECOND entry and left
  // the seeded one at zero — so the pane reported a ban catching traffic as catching nothing.
  test('an upper-case digest from the API lands on the entry we seeded', async () => {
    const { activity } = await withSummary([
      { clientJa4Digest: DIGEST.toUpperCase(), wafAction: 'deny', count: 40 },
    ]);
    expect(activity.get(DIGEST)).toEqual({ requests: 40, denied: 40 });
    expect(activity.size).toBe(1);
  });

  test('a digest the query covered but never saw is a real zero', async () => {
    const { activity } = await withSummary([]);
    expect(activity.get(DIGEST)).toEqual({ requests: 0, denied: 0 });
  });

  // Absent, not zero: zero is a measurement and this is the absence of one.
  test('a failed query leaves the map empty and reports the error', async () => {
    const real = await import('./observability');
    mock.module('./observability', () => ({
      ...real,
      metrics: async () => {
        throw new Error('metrics 504');
      },
    }));
    const { fetchDenyActivity } = await import('./denylist-data');
    const out = await fetchDenyActivity(CREDS, 144, [DIGEST]);
    expect(out.activity.size).toBe(0);
    expect(out.error).toContain('504');
  });

  test('allowed traffic counts as requests but not as denied', async () => {
    const { activity } = await withSummary([
      { clientJa4Digest: DIGEST, wafAction: 'allow', count: 12 },
      { clientJa4Digest: DIGEST, wafAction: 'deny', count: 3 },
    ]);
    expect(activity.get(DIGEST)).toEqual({ requests: 15, denied: 3 });
  });
});
