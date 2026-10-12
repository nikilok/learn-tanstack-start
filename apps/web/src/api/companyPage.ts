import { queryOptions } from '@tanstack/react-query';
import {
  createIsomorphicFn,
  createServerFn,
  createServerOnlyFn,
} from '@tanstack/react-start';

import {
  answerPage,
  companyPageStaleTime,
  type PageAnswer,
  pageOf,
} from '../lib/company/page-data';
import { PROFILE_UNAVAILABLE } from '../lib/company/profile-lookup';
import { ownerOrBrowser } from '../lib/device/browser-check.server';
import { setRpcCacheControl } from './cache-headers';
import { type CompanyProfileResult, companyProfile } from './companiesHouse';
import { type CompanyTimeline, companyTimeline } from './companyTimeline';
import { type CompanyBySlug, companyBySlug } from './hmrc';

/** What a company page shows apart from its extras: its licences, its Companies House profile and its timeline. */
export type CompanyPage = {
  company: CompanyBySlug | null;
  /** Null for a company not found, or with no Companies House record. */
  profile: CompanyProfileResult;
  timeline: CompanyTimeline | null;
};

/**
 * A company page's data, read on the server: by a crawler's full document directly, and by the
 * browser through `getCompanyPage`. A failed profile lookup degrades the page like a Companies
 * House outage does, and a failed timeline leaves it out: neither takes the page down.
 */
export const loadCompanyPage = createServerOnlyFn(
  async (slug: string): Promise<CompanyPage> => {
    const company = await companyBySlug(slug);
    if (company?.kind !== 'found')
      return { company, profile: null, timeline: null };
    const profile = await companyProfile(
      company.licences[0].organisationName,
    ).catch((error: unknown) => {
      console.error('[Profile] load failed:', error);
      return PROFILE_UNAVAILABLE;
    });
    const timeline =
      profile?.kind === 'found' && profile.company_number
        ? await companyTimeline(profile.company_number).catch(
            (error: unknown) => {
              console.error('[Timeline] load failed:', error);
              return null;
            },
          )
        : null;
    return { company, profile, timeline };
  },
);

/**
 * Server fn answering with a company page's data, for the browser. The browser check is asked on
 * every call, as for the extras: a call it names automated is `denied` while the check is
 * enforced. POST and never cached: the answer depends on the check.
 */
const getCompanyPage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const slug = (input as { slug?: unknown } | null)?.slug;
    if (typeof slug !== 'string') throw new Error('Invalid input');
    return { slug };
  })
  .handler(async ({ data: { slug } }): Promise<PageAnswer<CompanyPage>> => {
    setRpcCacheControl('private, no-store');
    return answerPage({
      allowed: () => ownerOrBrowser('page'),
      load: () => loadCompanyPage(slug),
    });
  });

/** A company page's data: read directly on the server, and through the data call in the browser. */
const fetchCompanyPage = createIsomorphicFn()
  .server((slug: string) => loadCompanyPage(slug))
  .client(
    async (slug: string): Promise<CompanyPage> =>
      pageOf(await getCompanyPage({ data: { slug } })),
  );

/** React Query options for a company page's data, fresh for as long as `companyPageStaleTime` says. */
export const companyPageQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ['company-page', slug],
    queryFn: () => fetchCompanyPage(slug),
    staleTime: (query) => companyPageStaleTime(query.state.data),
  });
