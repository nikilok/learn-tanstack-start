import Tooltip from './Tooltip';

function titleCase(str: string) {
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Filled circle — A rating (standard)
function IconCircleFilled({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <circle cx="10" cy="10" r="8" />
    </svg>
  );
}

// Open circle — Temporary A rating
function IconCircleOpen({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={className}
    >
      <circle cx="10" cy="10" r="7" />
    </svg>
  );
}

// Star — Premium
function IconStar({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M10 1.5l2.47 5.01 5.53.8-4 3.9.94 5.49L10 14.26 5.06 16.7 6 11.21l-4-3.9 5.53-.8z" />
    </svg>
  );
}

// Diamond — SME+
function IconDiamond({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M10 1L18 10L10 19L2 10Z" />
    </svg>
  );
}

// Clock — Provisional
function IconClock({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className={className}
    >
      <circle cx="10" cy="10" r="8" />
      <path d="M10 5v5l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Triangle down — B rating
function IconTriangleDown({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 6h14l-7 10z" />
    </svg>
  );
}

// Question mark — Unknown
function IconQuestion({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <circle cx="10" cy="10" r="8" fillOpacity="0.15" />
      <text
        x="10"
        y="14"
        textAnchor="middle"
        fontSize="11"
        fontWeight="bold"
        fill="currentColor"
      >
        ?
      </text>
    </svg>
  );
}

function getIcon(rating: string): {
  Icon: React.FC<{ className?: string }>;
  color: string;
} {
  const r = rating.toLowerCase();

  if (r.includes('premium')) return { Icon: IconStar, color: 'text-amber-500' };
  if (r.includes('sme+')) return { Icon: IconDiamond, color: 'text-blue-500' };
  if (r.includes('provisional'))
    return { Icon: IconClock, color: 'text-orange-400' };
  if (r.includes('b rating'))
    return { Icon: IconTriangleDown, color: 'text-red-400' };
  if (r.includes('a rating') && r.includes('temporary'))
    return { Icon: IconCircleOpen, color: 'text-green-400' };
  if (r.includes('a rating'))
    return { Icon: IconCircleFilled, color: 'text-green-500' };

  return { Icon: IconQuestion, color: 'text-(--sea-ink-soft)' };
}

export default function RatingIcon({ rating }: { rating: string }) {
  const { Icon, color } = getIcon(rating);

  return (
    <Tooltip text={titleCase(rating)}>
      <span
        className={`inline-flex cursor-pointer ${color}`}
        role="img"
        aria-label={rating}
      >
        <Icon className="h-5 w-5" />
      </span>
    </Tooltip>
  );
}
