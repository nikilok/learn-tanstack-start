/**
 * Decorative Union-Jack-filled magnifying-glass lens. Used as a small marker
 * (e.g. on the keyboard-highlighted result row) — the same visual motif as the
 * site logo, scaled down. Set `aria-hidden` and `pointer-events: none` on the
 * wrapper since this is purely ornamental.
 */
export default function UnionJackLens({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="48" fill="var(--logo-navy)" />
      <clipPath id="unionJackLensClip">
        <circle cx="50" cy="50" r="36" />
      </clipPath>
      <g clipPath="url(#unionJackLensClip)">
        <rect x="0" y="0" width="100" height="100" fill="#012169" />
        <path d="M0,0 L100,100 M100,0 L0,100" stroke="white" strokeWidth="14" />
        <path
          d="M0,0 L100,100 M100,0 L0,100"
          stroke="#C8102E"
          strokeWidth="5"
        />
        <path d="M50,0 V100 M0,50 H100" stroke="white" strokeWidth="24" />
        <path d="M50,0 V100 M0,50 H100" stroke="#C8102E" strokeWidth="14" />
      </g>
    </svg>
  );
}
