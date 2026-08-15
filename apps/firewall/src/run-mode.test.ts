import { describe, expect, test } from 'bun:test';

import { badgeFor, modeNote, runModeOf } from './run-mode';

describe('runModeOf', () => {
  test.each([
    ['live', { dryRun: false, mock: false }],
    ['dry-run', { dryRun: true, mock: false }],
    ['mock', { dryRun: false, mock: true }],
  ])('is %s', (expected, opts) => {
    expect(runModeOf(opts)).toBe(expected as never);
  });

  // The header used to be a ternary on dryRun alone, which has two answers — so a mock session,
  // whose data is synthetic and whose writes go to a sandbox, rendered as (LIVE).
  test('a mock session is never reported as live', () => {
    expect(runModeOf({ dryRun: false, mock: true })).not.toBe('live');
  });

  test('mock outranks dry-run: a sandboxed session cannot reach the real WAF at all', () => {
    expect(runModeOf({ dryRun: true, mock: true })).toBe('mock');
  });
});

describe('the header badge', () => {
  test('says which mode it is', () => {
    expect(badgeFor('live').text).toBe('(LIVE)');
    expect(badgeFor('dry-run').text).toBe('(DRY-RUN)');
    expect(badgeFor('mock').text).toBe('(MOCK)');
  });

  // Colour alone is what the two ordinary modes differ by, and it is what an operator glancing at
  // a familiar screen does not read.
  test('only mock is inverted, so it survives a glance', () => {
    expect(badgeFor('mock').inverse).toBe(true);
    expect(badgeFor('live').inverse).toBe(false);
    expect(badgeFor('dry-run').inverse).toBe(false);
  });

  test('every mode has a distinct colour', () => {
    const colours = (['live', 'dry-run', 'mock'] as const).map(
      (m) => badgeFor(m).color,
    );
    expect(new Set(colours).size).toBe(3);
  });
});

describe('the caption', () => {
  test('only a mock session has something to add', () => {
    expect(modeNote('mock')).toContain('synthetic');
    expect(modeNote('live')).toBeUndefined();
    expect(modeNote('dry-run')).toBeUndefined();
  });
});
