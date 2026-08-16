// The seams are module-level, so the thing worth locking is not that they can be replaced — it is
// that an ORDINARY run cannot have its data layer swapped from under it.

import { afterEach, describe, expect, test } from 'bun:test';

import {
  installObservabilityBackend,
  liveObservability,
  ruleNames,
} from '../observability';

const FLAGS = ['--mock', '--record'];

// Restored by snapshot, not by filtering: a filter also strips a flag the process was genuinely
// started with, which would change what isMock()/isRecording() report for every later file.
function withFlag<T>(flag: string, fn: () => T): T {
  const before = [...process.argv];
  process.argv.push(flag);
  try {
    return fn();
  } finally {
    process.argv = before;
  }
}

const ORIGINAL_ARGV = [...process.argv];
afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
});

describe('installing an observability backend', () => {
  test('is refused without a flag that says this is not an ordinary run', () => {
    expect(() => installObservabilityBackend(liveObservability)).toThrow(
      '--mock or --record',
    );
  });

  test.each(FLAGS)('is allowed under %s', (flag) => {
    withFlag(flag, () => {
      expect(() =>
        installObservabilityBackend(liveObservability),
      ).not.toThrow();
    });
  });

  // Asserted through ruleNames rather than metrics: denylist-data.test.ts module-mocks
  // ./observability to stub metrics, and a Bun module mock does not unwind between files.
  test('the installed backend is what later calls reach', async () => {
    const replaced = new Map([['rule_9', 'installed-backend']]);
    const ctx = {
      projectId: 'p',
      teamId: 't',
      headers: {},
      qs: '',
      startTime: '2026-08-15T04:00:00.000Z',
      endTime: '2026-08-15T10:00:00.000Z',
      granularity: { hours: 1 },
    };
    // The flag stays up across both installs. The afterEach cleanup is the backstop, not the plan:
    // leaving the stub in place would have every file after this one reading from it.
    withFlag('--mock', () =>
      installObservabilityBackend({
        metrics: async () => ({ data: [], summary: [] }),
        ruleNames: async () => replaced,
      }),
    );
    try {
      expect(await ruleNames(ctx)).toBe(replaced);
    } finally {
      // Put back whatever happens above, or every file after this one reads from the stub.
      withFlag('--mock', () => installObservabilityBackend(liveObservability));
    }
  });
});
