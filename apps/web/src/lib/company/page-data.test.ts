import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  answerPage,
  type CompanyPage,
  companyPageStaleTime,
  loadPage,
  PageDataRefusedError,
  pageOf,
  type PageFreshness,
  type PageReads,
} from './page-data';
import { PROFILE_UNAVAILABLE, profileStaleTime } from './profile-lookup';

const SLUG = 'acme-ltd';
const found = { kind: 'found' as const, nameSlug: SLUG };
const profile = { kind: 'found' as const, company_number: '01234567' };
const timeline = { companyNumber: '01234567', events: [] };

describe('companyPageStaleTime', () => {
  test('a complete page holds while it stays cached', () => {
    expect(
      companyPageStaleTime({ company: found, profile, timeline }, SLUG),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  test('a page with no Companies House record holds too: there is no timeline to wait for', () => {
    expect(
      companyPageStaleTime(
        { company: found, profile: null, timeline: null },
        SLUG,
      ),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  test('a miss, a rename, another spelling and nothing cached are stale at once', () => {
    const misses: (PageFreshness | undefined)[] = [
      { company: null, profile: null, timeline: null },
      {
        company: { kind: 'moved', nameSlug: 'acme-limited' },
        profile: null,
        timeline: null,
      },
      undefined,
    ];
    for (const page of misses) expect(companyPageStaleTime(page, SLUG)).toBe(0);
    expect(
      companyPageStaleTime({ company: found, profile, timeline }, 'Acme-Ltd'),
    ).toBe(0);
  });

  test('a Companies House outage is retried at the pace a failed profile is', () => {
    expect(
      companyPageStaleTime(
        { company: found, profile: PROFILE_UNAVAILABLE, timeline: null },
        SLUG,
      ),
    ).toBe(profileStaleTime(PROFILE_UNAVAILABLE));
  });

  test('a mapped company whose timeline did not load is stale at once', () => {
    expect(
      companyPageStaleTime({ company: found, profile, timeline: null }, SLUG),
    ).toBe(0);
  });
});

describe('loadPage', () => {
  let failed: ReturnType<typeof spyOn>;
  beforeEach(() => {
    failed = spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => failed.mockRestore());

  /** Reads answering with `company` and recording which were asked, each overridable. */
  function reads(
    company: Awaited<ReturnType<PageReads['company']>>,
    over: Partial<PageReads> = {},
  ) {
    const asked: string[] = [];
    const all: PageReads = {
      company: async (slug) => {
        asked.push(`company:${slug}`);
        return company;
      },
      profile: async (name) => {
        asked.push(`profile:${name}`);
        return {
          ...profile,
          company_status: 'active',
          type: 'ltd',
          date_of_creation: '2000-01-01',
          registered_office_address: {},
          accounts: undefined,
          company_name: 'ACME LTD',
          previousNames: [],
          sicDescriptions: [],
        };
      },
      timeline: async (number) => {
        asked.push(`timeline:${number}`);
        return timeline;
      },
      ...over,
    };
    return { asked, all };
  }

  const acme = {
    kind: 'found' as const,
    nameSlug: SLUG,
    licences: [{ organisationName: 'ACME LTD' }],
    extras: {},
  } as unknown as NonNullable<CompanyPage['company']>;

  test("a company's own slug reads its profile, then its timeline", async () => {
    const { asked, all } = reads(acme);
    const page = await loadPage(SLUG, all);
    expect(asked).toEqual([
      `company:${SLUG}`,
      'profile:ACME LTD',
      'timeline:01234567',
    ]);
    expect(page.timeline).toEqual(timeline);
  });

  test('another spelling, a rename and a miss stop at the slug lookup: their pages only redirect or 404', async () => {
    for (const [slug, company] of [
      ['Acme-Ltd', acme],
      [SLUG, { kind: 'moved' as const, nameSlug: 'acme-limited' }],
      [SLUG, null],
    ] as const) {
      const { asked, all } = reads(company);
      expect(await loadPage(slug, all)).toEqual({
        company,
        profile: null,
        timeline: null,
      });
      expect(asked).toEqual([`company:${slug}`]);
    }
  });

  test('a failed profile reads as an outage, and no timeline is read without it', async () => {
    const { asked, all } = reads(acme, {
      profile: async () => {
        throw new Error('Companies House down');
      },
    });
    const page = await loadPage(SLUG, all);
    expect(page.profile).toEqual(PROFILE_UNAVAILABLE);
    expect(page.timeline).toBeNull();
    expect(asked).toEqual([`company:${SLUG}`]);
  });

  test('a failed timeline leaves the page without one, never takes it down', async () => {
    const { all } = reads(acme, {
      timeline: async () => {
        throw new Error('trail read failed');
      },
    });
    const page = await loadPage(SLUG, all);
    expect(page.profile?.kind).toBe('found');
    expect(page.timeline).toBeNull();
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
