import { hmrcIngestionMeta } from '@ss/db';
import { createServerFn } from '@tanstack/react-start';
import { desc } from 'drizzle-orm';

import { db } from '../db.server';
import { formatRelative } from '../utils';

/**
 * Server fn returning a human-readable "time ago" string for the most recent
 * HMRC CSV ingestion, read from `hmrc_ingestion_meta`. Returns `null` when no
 * ingestion row exists or the query fails — callers should treat `null` as
 * "hide the indicator" rather than an error state.
 */
export const getLastIngestion = createServerFn().handler(async () => {
  try {
    const [row] = await db
      .select({ ingestedAt: hmrcIngestionMeta.ingestedAt })
      .from(hmrcIngestionMeta)
      .orderBy(desc(hmrcIngestionMeta.ingestedAt))
      .limit(1);

    if (!row) return null;
    return formatRelative(row.ingestedAt);
  } catch (err) {
    console.error('[getLastIngestion] failed', err);
    return null;
  }
});
