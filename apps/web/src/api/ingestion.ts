import { hmrcIngestionMeta } from '@ss/db';
import { createServerFn } from '@tanstack/react-start';
import { desc } from 'drizzle-orm';
import { db } from '../db.server';

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

export const getLastIngestion = createServerFn().handler(async () => {
  const [row] = await db
    .select({ ingestedAt: hmrcIngestionMeta.ingestedAt })
    .from(hmrcIngestionMeta)
    .orderBy(desc(hmrcIngestionMeta.ingestedAt))
    .limit(1);

  if (!row) return null;
  return formatRelative(row.ingestedAt);
});
