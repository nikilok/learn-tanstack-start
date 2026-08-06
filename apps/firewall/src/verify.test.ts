// firewall:verify checks the tool's own assumptions against live data, so its failure mode is the
// one it exists to catch: reporting agreement it never established.

import { describe, expect, test } from 'bun:test';

import { denylistCheck } from './verify';

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
