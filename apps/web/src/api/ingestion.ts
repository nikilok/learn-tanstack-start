import { hmrcIngestionMeta } from '@ss/db';
import { createServerFn } from '@tanstack/react-start';
import { desc } from 'drizzle-orm';
import { db } from '../db.server';

/**
 * Format the gap between `date` and now as a human-readable relative string
 * (e.g. "a few seconds ago", "5 mins ago", "3 hours ago", "2 days ago").
 */
function formatRelative(date: Date): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 45) return 'a few seconds ago';
  if (diffSec < 90) return '1 min ago';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 45) return `${diffMin} mins ago`;
  if (diffMin < 90) return '1 hour ago';
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 22) return `${diffHr} hours ago`;
  if (diffHr < 36) return '1 day ago';
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} days ago`;
}

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
