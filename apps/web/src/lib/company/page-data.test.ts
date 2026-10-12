import { describe, expect, test } from 'bun:test';

import {
  answerPage,
  companyPageStaleTime,
  PageDataRefusedError,
  pageOf,
  type PageFreshness,
} from './page-data';
import { PROFILE_UNAVAILABLE, profileStaleTime } from './profile-lookup';

const found = { kind: 'found' as const };
const profile = { kind: 'found' as const, company_number: '01234567' };
const timeline = { companyNumber: '01234567', events: [] };

describe('companyPageStaleTime', () => {
  test('a complete page holds while it stays cached', () => {
    expect(companyPageStaleTime({ company: found, profile, timeline })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test('a page with no Companies House record holds too: there is no timeline to wait for', () => {
    expect(
      companyPageStaleTime({ company: found, profile: null, timeline: null }),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  test('a miss, a rename and nothing cached are stale at once', () => {
    const misses: (PageFreshness | undefined)[] = [
      { company: null, profile: null, timeline: null },
      { company: { kind: 'moved' }, profile: null, timeline: null },
      undefined,
    ];
    for (const page of misses) expect(companyPageStaleTime(page)).toBe(0);
  });

  test('a Companies House outage is retried at the pace a failed profile is', () => {
    expect(
      companyPageStaleTime({
        company: found,
        profile: PROFILE_UNAVAILABLE,
        timeline: null,
      }),
    ).toBe(profileStaleTime(PROFILE_UNAVAILABLE));
  });

  test('a mapped company whose timeline did not load is stale at once', () => {
    expect(
      companyPageStaleTime({ company: found, profile, timeline: null }),
    ).toBe(0);
  });
});

describe('answerPage', () => {
  test('a refused call reads nothing', async () => {
    let read = false;
    const answer = await answerPage({
      allowed: async () => false,
      load: async () => {
        read = true;
        return 'page';
      },
    });
    expect(answer).toEqual({ status: 'denied' });
    expect(read).toBe(false);
  });

  test('an allowed call is answered with the page', async () => {
    expect(
      await answerPage({
        allowed: async () => true,
        load: async () => 'page',
      }),
    ).toEqual({ status: 'ok', page: 'page' });
  });
});

describe('pageOf', () => {
  test('the page of an answered call, and a refusal by name', () => {
    expect(pageOf({ status: 'ok', page: 'page' })).toBe('page');
    expect(() => pageOf({ status: 'denied' })).toThrow(PageDataRefusedError);
  });
});
