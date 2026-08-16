import { describe, expect, test } from 'bun:test';

import { badgeFor, modeNote, runModeOf, appliedNote } from './run-mode';

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
    expect(modeNote('mock')).toContain('sandboxed');
    expect(modeNote('live')).toBeUndefined();
    expect(modeNote('dry-run')).toBeUndefined();
  });

  // It said "synthetic data" while replaying a recording of real traffic — real client IPs and
  // real fingerprints — which invites an operator to treat the screen as safe to share.
  test('does not call recorded traffic synthetic', () => {
    expect(modeNote('mock')).not.toContain('synthetic');
    expect(modeNote('mock')).toContain('recorded');
  });
});

describe('the headless apply note', () => {
  // A recording refuses every write, and this line sat directly under those refusals claiming
  // live enforcement had been preserved.
  test('a recording says nothing was applied', () => {
    const note = appliedNote({ mock: false, recording: true });
    expect(note).toContain('read-only');
    expect(note).not.toContain('Live enforcement preserved');
  });

  test('a mock session says nothing reached production', () => {
    const note = appliedNote({ mock: true, recording: false });
    expect(note).toContain('Nothing reached production');
    expect(note).not.toContain('Live enforcement preserved');
  });

  test('an ordinary run still reports the live apply', () => {
    expect(appliedNote({ mock: false, recording: false })).toContain(
      'Live enforcement preserved',
    );
  });

  // --mock and --record are mutually exclusive at the entrypoint, but if that guard ever moves,
  // the sandboxed answer is the safe one to fall back to.
  test('mock wins if both are somehow set', () => {
    expect(appliedNote({ mock: true, recording: true })).toContain(
      'no credentials',
    );
  });
});
