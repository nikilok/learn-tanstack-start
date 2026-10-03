import { describe, expect, test } from 'bun:test';

import { PROFILE_UNAVAILABLE, profileStaleTime } from './profile-lookup';

describe('profileStaleTime', () => {
  test('a transient failure goes stale after a minute, so it is retried', () => {
    // Not 0: intent preloads re-run the loader on every hover, and each
    // retry is a Companies House call while the key is rate-limited.
    expect(profileStaleTime(PROFILE_UNAVAILABLE)).toBe(60_000);
  });

  test('a profile never goes stale while cached', () => {
    expect(profileStaleTime({ kind: 'found' })).toBe(Number.POSITIVE_INFINITY);
  });

  test('a verified absence never goes stale while cached', () => {
    expect(profileStaleTime(null)).toBe(Number.POSITIVE_INFINITY);
  });
});
