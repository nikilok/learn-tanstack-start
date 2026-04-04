export default function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className="mt-6 space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass animate-pulse rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <div className="h-4 w-48 rounded bg-(--sea-ink-soft)/15" />
              <div className="h-3 w-32 rounded bg-(--sea-ink-soft)/10" />
              <div className="h-3 w-24 rounded bg-(--sea-ink-soft)/10" />
            </div>
            <div className="h-3 w-28 shrink-0 rounded bg-(--sea-ink-soft)/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
