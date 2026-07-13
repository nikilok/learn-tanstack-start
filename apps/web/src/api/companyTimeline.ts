import {
  companiesHouseProfiles,
  companiesHouseProfileTrails,
  sicCodes,
} from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../db.server';
import { collectSicCodes, curateTimeline } from '../lib/timeline/curate';
import type { TimelineEvent, TrailRow } from '../lib/timeline/types';
import {
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setRpcCacheControl,
} from './cache-headers';

export type CompanyTimeline = {
  companyNumber: string;
  events: TimelineEvent[];
};

// Bounds a pathological company; production max is 27 rows today.
const TRAIL_ROW_LIMIT = 500;

/**
 * Server fn returning the curated change timeline for a company number:
 * trail diffs grouped into events plus the tracking-start/incorporated
 * anchors. Returns `null` for unknown company numbers.
 */
const getCompanyTimeline = createServerFn()
  .inputValidator((input: unknown) => {
    const { companyNumber } = input as { companyNumber: string };
    if (
      typeof companyNumber !== 'string' ||
      !/^[A-Za-z0-9]{1,20}$/.test(companyNumber)
    ) {
      throw new Error('Invalid company number');
    }
    return { companyNumber };
  })
  .handler(
    async ({ data: { companyNumber } }): Promise<CompanyTimeline | null> => {
      const [profile] = await db
        .select({ dateOfCreation: companiesHouseProfiles.dateOfCreation })
        .from(companiesHouseProfiles)
        .where(eq(companiesHouseProfiles.companyNumber, companyNumber))
        .limit(1);

      // Unknown number — short-cache the miss like the profile fn's 404 path.
      if (!profile) {
        setRpcCacheControl(SHORT_EDGE_CACHE);
        return null;
      }

      // Timestamps as ::text — the neon driver's Date mapping parses naive
      // timestamps in the local TZ and truncates the µs the grouping needs.
      const rows: TrailRow[] = await db
        .select({
          columnName: companiesHouseProfileTrails.columnName,
          oldValue: companiesHouseProfileTrails.oldValue,
          newValue: companiesHouseProfileTrails.newValue,
          createdAt: sql<string>`${companiesHouseProfileTrails.createdAt}::text`,
          publishedAt: sql<
            string | null
          >`${companiesHouseProfileTrails.publishedAt}::text`,
        })
        .from(companiesHouseProfileTrails)
        .where(eq(companiesHouseProfileTrails.companyNumber, companyNumber))
        .orderBy(
          desc(companiesHouseProfileTrails.createdAt),
          desc(companiesHouseProfileTrails.id),
        )
        .limit(TRAIL_ROW_LIMIT);
      rows.reverse();

      const codes = collectSicCodes(rows);
      const sicDescriptions = new Map<string, string>();
      if (codes.length > 0) {
        const descriptions = await db
          .select({ code: sicCodes.code, description: sicCodes.description })
          .from(sicCodes)
          .where(inArray(sicCodes.code, codes));
        for (const { code, description } of descriptions) {
          sicDescriptions.set(code, description);
        }
      }

      const events = curateTimeline({
        rows,
        dateOfCreation: profile.dateOfCreation,
        sicDescriptions,
      });

      // Same tag as the profile RPC + SSR doc, so the existing trail-driven
      // purge pipeline refreshes the timeline with no new wiring.
      setResponseHeader('x-vercel-cache-tag', `company-${companyNumber}`);
      setRpcCacheControl(LONG_EDGE_CACHE);

      return { companyNumber, events };
    },
  );

/** React Query options for `getCompanyTimeline`, keyed by company number. */
export const companyTimelineQueryOptions = (companyNumber: string) =>
  queryOptions({
    queryKey: ['company-timeline', companyNumber],
    queryFn: () => getCompanyTimeline({ data: { companyNumber } }),
  });
