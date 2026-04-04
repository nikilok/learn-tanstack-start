export default function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className="mt-6" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
        <div key={i} className="glass animate-pulse rounded-lg p-4" style={{ height: '120px' }}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-3">
              <div className="h-4 w-56 rounded bg-(--sea-ink-soft)/15" />
              <div className="h-3 w-36 rounded bg-(--sea-ink-soft)/10" />
              <div className="h-3 w-24 rounded bg-(--sea-ink-soft)/10" />
            </div>
            <div className="h-3 w-28 shrink-0 rounded bg-(--sea-ink-soft)/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
