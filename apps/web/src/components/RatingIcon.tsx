/**
 * Lowercase-then-capitalize the first letter of each word. Local copy so this
 * component can stand alone without pulling in the shared utils module.
 */
function titleCase(str: string) {
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Map an HMRC sponsor rating string to a Tailwind background class for the
 * status dot. Falls back to a neutral color when no keyword matches.
 */
function getRatingColor(rating: string) {
  const r = rating.toLowerCase();
  if (r.includes('premium')) return 'bg-amber-500';
  if (r.includes('sme+')) return 'bg-blue-500';
  if (r.includes('provisional')) return 'bg-orange-400';
  if (r.includes('b rating')) return 'bg-red-400';
  if (r.includes('a rating')) return 'bg-green-500';
  return 'bg-(--sea-ink-soft)';
}

/**
 * Inline rating label plus a colored status dot whose hue reflects the rating
 * tier (premium/sme+/provisional/A/B). The title-cased rating is also set as
 * the `title` attribute for hover disambiguation.
 */
export default function RatingIcon({ rating }: { rating: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm text-(--sea-ink-soft)"
      title={titleCase(rating)}
    >
      {titleCase(rating)}
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${getRatingColor(rating)}`}
      />
    </span>
  );
}
