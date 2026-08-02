import { companyWebsites } from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { and, eq } from 'drizzle-orm';

import { db } from '../db.server';
import { publishableWebsiteGate } from '../lib/websites/publishable';
import {
  LONG_EDGE_CACHE,
  setCompanyCacheTag,
  setRpcCacheControl,
} from './cache-headers';

/**
 * The URL and nothing else. Evidence decides whether a row qualifies and then
 * stays in the database: the UI has no use for it, so fetching it would only
 * widen the payload and put the tier in the SSR hydration blob.
 */
export type CompanyWebsite = {
  url: string;
};

/**
 * Server fn returning the company's own website, or `null` when we have not
 * confirmed one. Null is the ordinary answer for most companies today.
 *
 * The render gate is all three conditions together and this is its only
 * expression: `verified` says the row survived discovery, `checked_at` says a
 * sweep actually fetched the URL, and the evidence filter says the proof was
 * the company's own registration number rather than a third-party listing.
 * Status alone once shipped links we could not reach, which is why the
 * `unreachable` status exists.
 */
const getCompanyWebsite = createServerFn()
  .inputValidator((input: unknown) => {
    const companyNumber = (input as { companyNumber?: unknown } | null)
      ?.companyNumber;
    if (
      typeof companyNumber !== 'string' ||
      !/^[A-Za-z0-9]{1,20}$/.test(companyNumber)
    ) {
      throw new Error('Invalid company number');
    }
    return { companyNumber };
  })
  .handler(
    async ({ data: { companyNumber } }): Promise<CompanyWebsite | null> => {
      const [row] = await db
        .select({ url: companyWebsites.url })
        .from(companyWebsites)
        .where(
          and(
            eq(companyWebsites.companyNumber, companyNumber),
            publishableWebsiteGate(),
          ),
        )
        .limit(1);

      // Same tag as the profile RPC and the SSR document, so one purge moves
      // the page and this together. A miss caches as long as a hit: "no
      // website" is the steady state for almost every company, and
      // short-caching it would put nearly every company page on the short TTL.
      setCompanyCacheTag(companyNumber);
      setRpcCacheControl(LONG_EDGE_CACHE);

      if (!row?.url) return null;
      return { url: row.url };
    },
  );

/** React Query options for `getCompanyWebsite`, keyed by company number. */
export const companyWebsiteQueryOptions = (companyNumber: string) =>
  queryOptions({
    queryKey: ['company-website', companyNumber],
    queryFn: () => getCompanyWebsite({ data: { companyNumber } }),
  });
