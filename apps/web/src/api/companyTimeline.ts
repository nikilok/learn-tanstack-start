import { companiesHouseProfiles, companiesHouseProfileTrails } from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../db.server';
import { collectSicCodes, curateTimeline } from '../lib/timeline/curate';
import type { TimelineEvent, TrailRow } from '../lib/timeline/types';
import {
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setCompanyCacheTag,
  setRpcCacheControl,
} from './cache-headers';
import { loadSicDescriptions } from './sic';

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
    async ({ data: { companyNumber } }): Promise<CompanyTimeline | null> => {
      // Timestamps as ::text — the neon driver's Date mapping parses naive
      // timestamps in the local TZ and truncates the µs the grouping needs.
      const [profileRows, trailRows] = await Promise.all([
        db
          .select({
            dateOfCreation: companiesHouseProfiles.dateOfCreation,
            companyName: companiesHouseProfiles.companyName,
            previousCompanyNamesDated:
              companiesHouseProfiles.previousCompanyNamesDated,
          })
          .from(companiesHouseProfiles)
          .where(eq(companiesHouseProfiles.companyNumber, companyNumber))
          .limit(1),
        db
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
          .limit(TRAIL_ROW_LIMIT),
      ]);

      // Unknown number — short-cache the miss like the profile fn's 404 path.
      const [profile] = profileRows;
      if (!profile) {
        setRpcCacheControl(SHORT_EDGE_CACHE);
        return null;
      }

      let rows: TrailRow[] = trailRows;
      const truncated = rows.length === TRAIL_ROW_LIMIT;
      if (truncated) {
        // The limit can split the oldest same-created_at batch mid-event,
        // which would curate a partial (never-existed) change — drop it.
        const oldest = rows[rows.length - 1].createdAt;
        rows = rows.filter((row) => row.createdAt !== oldest);
      }
      rows.reverse();

      const descriptions = await loadSicDescriptions(collectSicCodes(rows));
      const sicDescriptions = new Map(
        descriptions.map(({ code, description }) => [code, description]),
      );

      const events = curateTimeline({
        rows,
        dateOfCreation: profile.dateOfCreation,
        previousCompanyNamesDated: profile.previousCompanyNamesDated,
        currentName: profile.companyName,
        sicDescriptions,
        truncated,
      });

      // Same tags as the profile RPC + SSR doc, so both purge pipelines
      // refresh the timeline with no new wiring.
      setCompanyCacheTag(companyNumber);
      setRpcCacheControl(LONG_EDGE_CACHE);

      return { companyNumber, events };
    },
  );

/**
 * React Query options for `getCompanyTimeline`, keyed by company number.
 * A null result can be the profile-upsert race on a first visit — mark it
 * immediately stale so the next navigation refetches instead of pinning the
 * miss for the whole SPA session (non-null keeps the router's 5-min default).
 */
export const companyTimelineQueryOptions = (companyNumber: string) =>
  queryOptions({
    queryKey: ['company-timeline', companyNumber],
    queryFn: () => getCompanyTimeline({ data: { companyNumber } }),
    staleTime: (query) => (query.state.data === null ? 0 : 5 * 60 * 1000),
  });
