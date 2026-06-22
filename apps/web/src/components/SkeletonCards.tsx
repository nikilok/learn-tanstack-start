/**
 * Single shimmer row matching the compact layout of `HmrcCard` (title plus one
 * metadata row) so the placeholder occupies the same vertical space as a real
 * result and the loading→loaded swap doesn't shift.
 */
function SkeletonRow() {
  return (
    <div className="animate-pulse py-2">
      {/* title — same as HmrcCard h3 */}
      <h3 className="heading-card text-base font-semibold text-(--sea-ink)">
        <span className="inline-block h-4 w-44 rounded bg-(--sea-ink-soft)/15" />
      </h3>
      {/* metadata — one row ≥sm, stacks to three lines <sm (matches HmrcCard) */}
      <div className="mt-1 flex flex-col items-start gap-y-1 sm:flex-row sm:items-center sm:gap-x-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-28 rounded bg-(--sea-ink-soft)/10" />
          <span className="inline-block h-2 w-2 rounded-full bg-(--sea-ink-soft)/15" />
        </span>
        <span className="inline-block h-3.5 w-20 rounded bg-(--sea-ink-soft)/10" />
        <span className="inline-block h-5 w-24 rounded-md bg-(--sea-ink-soft)/10" />
      </div>
    </div>
  );
}

/**
 * Renders `count` skeleton rows in a padded column, or a bare fragment when
 * `bare` is true (used for the load-more footer inside the existing results
 * container, which already supplies the matching padding).
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
          // oxlint-disable-next-line react/no-array-index-key -- static skeleton placeholders never reorder
          <SkeletonRow key={i} />
        ))}
      </>
    );
  }

  return (
    <div className="relative mt-6 flex flex-col gap-6 px-4 py-2">
      {/* Static rail matching HmrcResults's RAIL_X (≈ the content column's left
          edge) so loading→loaded doesn't pop; the marker only appears once a row
          is highlighted */}
      <span
        aria-hidden
        className="guide-rail pointer-events-none absolute top-2 bottom-2 left-0 w-px rounded-full"
      />
      {Array.from({ length: count }).map((_, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- static skeleton placeholders never reorder
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
