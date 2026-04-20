import { useSuspenseQuery } from '@tanstack/react-query';
import { getLastIngestion } from '../api/ingestion';

export default function LastUpdated() {
  const { data } = useSuspenseQuery({
    queryKey: ['last-ingestion'],
    queryFn: () => getLastIngestion(),
    staleTime: 60_000,
  });
  if (!data) return null;
  return (
    <div className="flex items-center gap-2 rounded-full border border-(--line) bg-(--bg-base)/80 px-4 py-1 text-sm text-(--sea-ink-faint) backdrop-blur-sm">
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        width="14"
        height="14"
        className="text-(--ok)"
      >
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M4.8 8.2l2 2 4.4-4.6"
          fill="none"
          stroke="#ffffff"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Last updated {data}</span>
    </div>
  );
}

export function LastUpdatedSkeleton() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-(--line) bg-(--bg-base)/80 px-4 py-1 backdrop-blur-sm">
      <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-(--sea-ink-soft)/20" />
      <span className="h-3.5 w-40 animate-pulse rounded bg-(--sea-ink-soft)/15" />
    </div>
  );
}
