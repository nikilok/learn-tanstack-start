import { useId } from 'react';

interface BrandMarkProps {
  className?: string;
  navyColor?: string;
  redColor?: string;
}

/**
 * SponsorSearch mark (Union-Jack magnifying glass) as inline JSX — mirrors the web
 * app's Logo: the navy frame + flag red are CSS-var props that theme with light/dark,
 * the flag blue/white are fixed.
 */
export function BrandMark({
  className,
  navyColor = 'var(--tb-mark)',
  redColor = 'var(--tb-mark-red)',
}: BrandMarkProps) {
  // Unique per instance — the mark can appear twice (left cluster + title pill).
  const clipId = `mark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg
      viewBox="0 0 130 130"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="SponsorSearch"
      className={className}
    >
      {/* Frame + magnifying glass — themeable navy */}
      <path
        d="M75,10 H20 A10,10 0 0 0 10,20 V100 A10,10 0 0 0 20,110 H85"
        fill="none"
        stroke={navyColor}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path
        d="M100,35 V20 A10,10 0 0 0 90,10 H85"
        fill="none"
        stroke={navyColor}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <rect
        x={95}
        y={100}
        width={14}
        height={30}
        rx={6}
        ry={6}
        fill={navyColor}
        transform="rotate(-45 95 100)"
      />
      <rect
        x={98}
        y={80}
        width={7}
        height={30}
        rx={6}
        ry={6}
        fill={navyColor}
        transform="rotate(-45 95 100)"
      />
      <circle cx={60} cy={60} r={38} fill={navyColor} />
      {/* Union Jack — fixed blue/white, themeable red */}
      <clipPath id={clipId}>
        <circle cx={60} cy={60} r={29} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x={18} y={18} width={84} height={84} fill="#012169" />
        <path
          d="M18,18 L102,102 M102,18 L18,102"
          stroke="#fff"
          strokeWidth={12}
        />
        <path
          d="M18,18 L102,102 M102,18 L18,102"
          stroke={redColor}
          strokeWidth={4}
        />
        <path d="M60,18 V102 M18,60 H102" stroke="#fff" strokeWidth={20} />
        <path d="M60,18 V102 M18,60 H102" stroke={redColor} strokeWidth={12} />
      </g>
    </svg>
  );
}
