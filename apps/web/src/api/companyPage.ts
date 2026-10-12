import { queryOptions } from '@tanstack/react-query';
import {
  createIsomorphicFn,
  createServerFn,
  createServerOnlyFn,
} from '@tanstack/react-start';

import {
  answerPage,
  type CompanyPage,
  companyPageStaleTime,
  loadPage,
  type PageAnswer,
  pageOf,
} from '../lib/company/page-data';
import { pageAllowed } from '../lib/device/browser-check.server';
import { clientSafeError, failureLogLine } from '../lib/server-fn-errors';
import { setRpcCacheControl } from './cache-headers';
import { companyProfile } from './companiesHouse';
import { companyTimeline } from './companyTimeline';
import { companyBySlug } from './hmrc';

/** A company page's data, read on the server: by a full document directly, and by the browser through `getCompanyPage`. */
export const loadCompanyPage = createServerOnlyFn(
  (slug: string): Promise<CompanyPage> =>
    loadPage(slug, {
      company: companyBySlug,
      profile: companyProfile,
      timeline: companyTimeline,
    }),
);

/**
 * Server fn answering with a company page's data, for the browser. The browser check is asked on
 * every call, as for the extras, and a call it names automated is `denied` while company pages
 * and the check are both enforced (`pageAllowed`). POST and never cached: the answer depends on
 * the check.
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
      allowed: () => pageAllowed(),
      load: () => loadCompanyPage(slug),
    });
  });

/**
 * A company page's data: read directly on the server, and through the data call in the browser. A
 * server-side failure is logged once and reaches the page as the generic error, as the server
 * function middleware (`start.ts`) does for a call.
 */
const fetchCompanyPage = createIsomorphicFn()
  .server(async (slug: string): Promise<CompanyPage> => {
    try {
      return await loadCompanyPage(slug);
    } catch (error) {
      const safe = clientSafeError(error);
      if (safe !== error)
        console.error(failureLogLine('loadCompanyPage', error));
      throw safe;
    }
  })
  .client(
    async (slug: string): Promise<CompanyPage> =>
      pageOf(await getCompanyPage({ data: { slug } })),
  );

/** React Query options for a company page's data, fresh for as long as `companyPageStaleTime` says. */
export const companyPageQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ['company-page', slug],
    queryFn: () => fetchCompanyPage(slug),
    staleTime: (query) => companyPageStaleTime(query.state.data, slug),
  });
