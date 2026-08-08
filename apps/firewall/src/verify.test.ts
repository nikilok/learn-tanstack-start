// firewall:verify checks the tool's own assumptions against live data, so its failure mode is the
// one it exists to catch: reporting agreement it never established.

import { describe, expect, test } from 'bun:test';

import { denylistCheck, narrowingCheck, summaryLine } from './verify';

// `every` over an empty list is true, so the danger here is a check that reports a pass having
// tested nothing. Each case below is one way that happens.
describe('denylistCheck', () => {
  const base = {
    denylistRead: true,
    denied: 2,
    stillArriving: ['a'],
    surfaced: new Set(['a']),
    capped: false,
  };

  test('passes only when a still-arriving denied digest was surfaced', () => {
    expect(denylistCheck(base)).toBe(true);
  });

  test('fails when the screen missed one', () => {
    expect(denylistCheck({ ...base, surfaced: new Set<string>() })).toBe(false);
  });

  test('an unreadable denylist is a failure, not an unknown', () => {
    // The list is the labelling this check runs against; not reading it is a fault of ours.
    expect(denylistCheck({ ...base, denylistRead: false })).toBe(false);
  });

  test('nothing denied is inconclusive, not a pass', () => {
    expect(denylistCheck({ ...base, denied: 0, stillArriving: [] })).toBeNull();
  });

  test('everything fully stopped is inconclusive — that is the ban working', () => {
    // The window is entirely after the ban, so it says nothing about the screen either way.
    expect(denylistCheck({ ...base, stillArriving: [] })).toBeNull();
  });

  test('a capped response is inconclusive even when it looks clean', () => {
    // At the cap a denied digest can be missing from the breakdown and read as stopped, which
    // shrinks stillArriving and manufactures the vacuous pass.
    expect(denylistCheck({ ...base, capped: true })).toBeNull();
  });

  test('capped outranks a result that would otherwise fail', () => {
    expect(
      denylistCheck({ ...base, capped: true, surfaced: new Set<string>() }),
    ).toBeNull();
  });
});

describe('narrowingCheck', () => {
  test('a window where nothing reached the app is inconclusive, not a failure', () => {
    // agrees(0, 0) is true, so the binary form scored this as DISAGREEING and exited 1 on any
    // quiet or deny-only window. A check with no evidence has not failed; it has not run.
    expect(narrowingCheck(0, 0)).toBeNull();
  });

  test('more than one action reaching the app is the expected state', () => {
    expect(narrowingCheck(1000, 400)).toBe(true);
  });

  test('one action accounting for everything is a real disagreement', () => {
    // The screen having been narrowed back to naming `allow` alone — what this exists to catch.
    expect(narrowingCheck(1000, 1000)).toBe(false);
  });

  test('within tolerance still counts as one action accounting for it', () => {
    expect(narrowingCheck(1000, 999)).toBe(false);
  });
});

describe('summaryLine', () => {
  const c = (ok: boolean | null) => ({ ok });

  test('inconclusive checks are never folded into the pass', () => {
    // The bug: `all 3 assumptions agree with live data` while one of them was undecidable —
    // the vacuous pass, in the one line an operator reads.
    const out = summaryLine([c(true), c(true), c(null)]);
    expect(out).not.toContain('all 3');
    expect(out).toContain('2 of 3');
    expect(out).toContain('1 could not be checked');
  });

  test('all true really is all agreeing', () => {
    expect(summaryLine([c(true), c(true)])).toBe(
      'all 2 assumptions agree with live data',
    );
  });

  test('a disagreement outranks an inconclusive', () => {
    const out = summaryLine([c(false), c(null), c(true)]);
    expect(out).toBe('1 of 3 assumptions disagree with live data');
  });

  test('every check inconclusive does not read as agreement', () => {
    expect(summaryLine([c(null), c(null)])).toContain('0 of 2');
  });
});
