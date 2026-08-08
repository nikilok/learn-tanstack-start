import { describe, expect, test } from 'bun:test';

import {
  isEdgeDenied,
  probeDelayMs,
  probeStillDenied,
  simulatedReason,
} from './block-detect.ts';

const facts = (over: Partial<Parameters<typeof isEdgeDenied>[0]> = {}) => ({
  statusCode: 200,
  resourceType: 'xhr',
  ...over,
});

describe('isEdgeDenied', () => {
  test('a refused RPC is a refusal, on any resource type', () => {
    expect(
      isEdgeDenied(
        facts({
          statusCode: 403,
          responseHeaders: { 'x-vercel-mitigated': ['deny'] },
        }),
      ),
    ).toBe(true);
  });

  test('the header is read case-insensitively', () => {
    expect(
      isEdgeDenied(
        facts({
          statusCode: 403,
          responseHeaders: { 'X-Vercel-Mitigated': ['Deny'] },
        }),
      ),
    ).toBe(true);
  });

  test('a challenge is not a refusal — the view can solve it', () => {
    // Covering it would replace the only path back with a screen that never clears.
    expect(
      isEdgeDenied(
        facts({
          statusCode: 403,
          resourceType: 'mainFrame',
          responseHeaders: { 'x-vercel-mitigated': ['challenge'] },
        }),
      ),
    ).toBe(false);
  });

  test('a document 403 counts without the header', () => {
    expect(
      isEdgeDenied(facts({ statusCode: 403, resourceType: 'mainFrame' })),
    ).toBe(true);
  });

  test('an unmarked 403 on a sub-resource does not count', () => {
    // The tile proxy passes an upstream 403 straight through, and that is not our edge.
    expect(
      isEdgeDenied(facts({ statusCode: 403, resourceType: 'image' })),
    ).toBe(false);
  });

  test('every other status is untouched', () => {
    for (const statusCode of [200, 304, 404, 429, 500, 502]) {
      expect(
        isEdgeDenied(facts({ statusCode, resourceType: 'mainFrame' })),
      ).toBe(false);
    }
  });

  test('a challenge on its own status is left alone', () => {
    // Measured against production: a challenge comes back 429, not 403.
    expect(
      isEdgeDenied(
        facts({
          statusCode: 429,
          resourceType: 'mainFrame',
          responseHeaders: { 'x-vercel-mitigated': ['challenge'] },
        }),
      ),
    ).toBe(false);
  });
});

describe('probeStillDenied', () => {
  test('403 means still refused', () => {
    expect(probeStillDenied(403, 'deny')).toBe(true);
    expect(probeStillDenied(403, null)).toBe(true);
  });

  test('a challenge counts as clear — the page can take it from here', () => {
    expect(probeStillDenied(429, 'challenge')).toBe(false);
    expect(probeStillDenied(403, 'challenge')).toBe(false);
  });

  test('anything that is not a 403 is clear, errors included', () => {
    // A 500 means the request reached the app, which is all this is asking.
    expect(probeStillDenied(200, null)).toBe(false);
    expect(probeStillDenied(500, null)).toBe(false);
  });
});

describe('simulatedReason', () => {
  test('no flags means no simulation', () => {
    expect(simulatedReason({})).toBe(null);
    expect(simulatedReason({ PATH: '/usr/bin' })).toBe(null);
  });

  test('each flag asks for its own state', () => {
    expect(simulatedReason({ DESKTOP_SIMULATE_RATE_LIMIT: '1' })).toBe(
      'blocked',
    );
    expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: '1' })).toBe('offline');
    expect(simulatedReason({ DESKTOP_SIMULATE_UNREACHABLE: '1' })).toBe(
      'unreachable',
    );
  });

  test('any truthy value turns one on', () => {
    expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: 'yes' })).toBe(
      'offline',
    );
    expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: 'true' })).toBe(
      'offline',
    );
  });

  test('off values read as off, so a stale export does not hold the screen up', () => {
    for (const value of ['', '0', 'false']) {
      expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: value })).toBe(null);
    }
  });

  test('two at once resolves to one, not to whichever the environment ordered first', () => {
    expect(
      simulatedReason({
        DESKTOP_SIMULATE_OFFLINE: '1',
        DESKTOP_SIMULATE_RATE_LIMIT: '1',
      }),
    ).toBe('blocked');
  });
});

describe('probeDelayMs', () => {
  test('a dropped connection is checked far sooner than a refusal', () => {
    expect(probeDelayMs('offline', 0)).toBeLessThan(probeDelayMs('blocked', 0));
  });

  test('delays grow with each failed attempt', () => {
    const steps = [0, 1, 2, 3].map((n) => probeDelayMs('blocked', n));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length);
  });

  test('holds at the last step instead of growing without bound', () => {
    const last = probeDelayMs('offline', 4);
    expect(probeDelayMs('offline', 99)).toBe(last);
    expect(probeDelayMs('offline', 1e6)).toBe(last);
  });

  test('a nonsense attempt falls back to the first step', () => {
    const first = probeDelayMs('blocked', 0);
    expect(probeDelayMs('blocked', -3)).toBe(first);
    expect(probeDelayMs('blocked', Number.NaN)).toBe(first);
  });
});
