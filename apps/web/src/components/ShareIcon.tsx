const iconClass = 'h-[18px] w-[18px]';

/**
 * Custom "share" glyph — three nodes joined by two links, the universal share
 * symbol. Stroked with `currentColor` to match the sibling header icons; sized
 * and marked `aria-hidden` the same way so it sits flush next to the toggles.
 */
export default function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={iconClass}
      aria-hidden="true"
    >
      <circle cx="17" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="17" cy="19" r="2.5" />
      <line x1="8.1" y1="10.7" x2="14.9" y2="6.3" />
      <line x1="8.1" y1="13.3" x2="14.9" y2="17.7" />
    </svg>
  );
}
