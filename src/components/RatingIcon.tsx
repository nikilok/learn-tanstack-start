function titleCase(str: string) {
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function getRatingColor(rating: string) {
  const r = rating.toLowerCase();
  if (r.includes('premium')) return 'bg-amber-500';
  if (r.includes('sme+')) return 'bg-blue-500';
  if (r.includes('provisional')) return 'bg-orange-400';
  if (r.includes('b rating')) return 'bg-red-400';
  if (r.includes('a rating')) return 'bg-green-500';
  return 'bg-(--sea-ink-soft)';
}

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
