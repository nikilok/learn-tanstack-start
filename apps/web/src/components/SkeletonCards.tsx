/**
 * Single shimmer row matching the layout of `HmrcCard` (title, rating, location,
 * route) so the placeholder occupies the same vertical space as a real result.
 */
function SkeletonRow() {
  return (
    <div className="animate-pulse py-2">
      {/* title — same as HmrcCard h3 */}
      <h3 className="heading-card text-base font-semibold text-(--sea-ink)">
        <span className="inline-block h-4 w-44 rounded bg-(--sea-ink-soft)/15" />
      </h3>
      {/* rating — same as HmrcCard rating wrapper */}
      <div className="mt-0.5">
        <span className="inline-flex items-center gap-1.5 text-sm text-(--sea-ink-soft)">
          <span className="inline-block h-3.5 w-32 rounded bg-(--sea-ink-soft)/10" />
          <span className="inline-block h-2 w-2 rounded-full bg-(--sea-ink-soft)/15" />
        </span>
      </div>
      {/* location + route — same as HmrcCard bottom block */}
      <div className="mt-0.5">
        <p className="text-sm text-(--sea-ink-soft)">
          <span className="inline-block h-3.5 w-24 rounded bg-(--sea-ink-soft)/10" />
        </p>
        <p className="mt-0.5 truncate text-xs text-(--sea-ink-soft)">
          <span className="inline-block h-3 w-20 rounded bg-(--sea-ink-soft)/10" />
        </p>
      </div>
    </div>
  );
}

/**
 * Renders `count` skeleton rows inside the sponsor-card container, or a bare
 * fragment when `bare` is true (used for the load-more footer inside an
 * existing results panel so rows don't double up their background).
 */
export default function SkeletonCards({
  count = 6,
  bare = false,
}: {
  count?: number;
  bare?: boolean;
}) {
  if (bare) {
    return (
      <>
        {Array.from({ length: count }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
          <SkeletonRow key={i} />
        ))}
      </>
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-6 rounded-lg bg-(--sponsor-card-bg) shadow-(--shadow-card) px-4 py-2">
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders never reorder
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
