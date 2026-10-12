import { companiesHouseProfiles, companiesHouseProfileTrails } from '@ss/db';
import { createServerOnlyFn } from '@tanstack/react-start';
import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../db.server';
import { collectSicCodes, curateTimeline } from '../lib/timeline/curate';
import type { TimelineEvent, TrailRow } from '../lib/timeline/types';
import { loadSicDescriptions } from './sic';

export type CompanyTimeline = {
  companyNumber: string;
  events: TimelineEvent[];
};

// Bounds a pathological company; production max is 27 rows today.
const TRAIL_ROW_LIMIT = 500;

/**
 * The curated change timeline for a company number: trail diffs grouped into
 * events plus the tracking-start/incorporated anchors. Returns `null` for
 * unknown company numbers. Server only: read by the page's data call
 * (`companyPage.ts`).
 */
export const companyTimeline = createServerOnlyFn(
  async (companyNumber: string): Promise<CompanyTimeline | null> => {
    if (
      typeof companyNumber !== 'string' ||
      !/^[A-Za-z0-9]{1,20}$/.test(companyNumber)
    ) {
      throw new Error('Invalid company number');
    }
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

    // Unknown number: no timeline.
    const [profile] = profileRows;
    if (!profile) return null;

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

    return { companyNumber, events };
  },
);
