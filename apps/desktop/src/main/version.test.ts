import { describe, expect, test } from 'bun:test';

import { isNewer } from './version.ts';

describe('isNewer', () => {
  test('a higher patch / minor / major is newer', () => {
    expect(isNewer('0.2.2', '0.2.1')).toBe(true);
    expect(isNewer('0.3.0', '0.2.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  });

  test('equal versions are not newer', () => {
    expect(isNewer('0.2.1', '0.2.1')).toBe(false);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.0.0', '0.0.0')).toBe(false);
  });

  test('older versions are not newer', () => {
    expect(isNewer('0.2.1', '0.2.2')).toBe(false);
    expect(isNewer('0.2.9', '0.3.0')).toBe(false);
    expect(isNewer('0.9.9', '1.0.0')).toBe(false);
  });

  test('segments compare numerically, not lexically', () => {
    // '10' > '9' as numbers but '10' < '9' as strings — the classic naive-compare bug.
    expect(isNewer('0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('10.0.0', '2.0.0')).toBe(true);
    expect(isNewer('0.2.9', '0.2.10')).toBe(false);
    expect(isNewer('2.0.0', '10.0.0')).toBe(false);
  });

  test('tolerates a leading v/V prefix', () => {
    expect(isNewer('v0.3.0', '0.2.0')).toBe(true);
    expect(isNewer('0.3.0', 'v0.2.0')).toBe(true);
    expect(isNewer('V1.0.0', 'v0.9.0')).toBe(true);
    expect(isNewer('v0.2.0', 'v0.2.0')).toBe(false);
  });

  test('ignores +build metadata (not version-significant)', () => {
    expect(isNewer('0.3.0+build.9', '0.2.0')).toBe(true);
    expect(isNewer('0.2.5+meta', '0.2.5')).toBe(false);
    expect(isNewer('0.2.0+abc', '0.2.0+xyz')).toBe(false);
  });

  test('a full release outranks a prerelease of the same core', () => {
    expect(isNewer('0.3.0', '0.3.0-rc.1')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0-beta.2')).toBe(true);
    expect(isNewer('0.3.0-rc.1', '0.3.0')).toBe(false);
  });

  test('a prerelease of a higher core still beats a lower release', () => {
    expect(isNewer('0.3.0-rc.1', '0.2.9')).toBe(true);
    expect(isNewer('0.2.9', '0.3.0-rc.1')).toBe(false);
  });

  test('prerelease + build metadata together parse correctly', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1+build.5')).toBe(true);
    expect(isNewer('1.0.0-rc.1+build.5', '0.9.0')).toBe(true);
  });

  test('missing trailing segments are treated as zero', () => {
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('1.2.1', '1.2')).toBe(true);
    expect(isNewer('1', '0.9.9')).toBe(true);
    expect(isNewer('2', '2.0.0')).toBe(false);
  });

  test('malformed / non-numeric input never falsely reports newer', () => {
    expect(isNewer('not-a-version', '0.2.1')).toBe(false);
    expect(isNewer('', '0.2.1')).toBe(false);
    expect(isNewer('0.2.x', '0.2.1')).toBe(false); // x -> 0, so [0,2,0] < [0,2,1]
    expect(isNewer('   ', '0.2.1')).toBe(false);
  });

  test('a real version outranks garbage (garbage -> 0.0.0)', () => {
    expect(isNewer('0.2.1', 'garbage')).toBe(true);
    expect(isNewer('0.2.1', '')).toBe(true);
  });

  test("the feature's actual path: 0.2.1 checking the feed", () => {
    const current = '0.2.1';
    expect(isNewer('0.2.2', current)).toBe(true);
    expect(isNewer('0.2.1', current)).toBe(false);
    expect(isNewer('0.2.0', current)).toBe(false);
    expect(isNewer('0.3.0', current)).toBe(true);
    expect(isNewer('0.2.10', current)).toBe(true);
    expect(isNewer('1.0.0', current)).toBe(true);
  });
});
