import { useSuspenseQuery } from '@tanstack/react-query';
import { getLastIngestion } from '../api/ingestion';
import CheckCircleIcon from './CheckCircleIcon';

/**
 * Ingestion freshness pill showing "Last updated {relative time}" sourced from
 * the `getLastIngestion` server fn. Suspends on first load; returns `null` when
 * the query resolves to no data so the pill disappears cleanly.
 */
export default function LastUpdated() {
  const { data } = useSuspenseQuery({
    queryKey: ['last-ingestion'],
    queryFn: () => getLastIngestion(),
    staleTime: 60_000,
  });
  if (!data) return null;
  return (
    <div className="flex items-center gap-2 rounded-full border border-(--line) bg-(--bg-base)/80 px-4 py-1 text-sm text-(--sea-ink-faint) backdrop-blur-sm">
      <CheckCircleIcon className="h-3.5 w-3.5 text-(--ok)" />
      <span>Last updated {data}</span>
    </div>
  );
}

/**
 * Shimmer placeholder matching the dimensions of `LastUpdated`. Rendered inside
 * the Suspense fallback in `Footer` while the ingestion query is pending.
 */
export function LastUpdatedSkeleton() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-(--line) bg-(--bg-base)/80 px-4 py-1 backdrop-blur-sm">
      <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-(--sea-ink-soft)/20" />
      <span className="h-3.5 w-40 animate-pulse rounded bg-(--sea-ink-soft)/15" />
    </div>
  );
}
