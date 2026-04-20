/**
 * Filled circle with a white checkmark stroke inside. The outer circle uses
 * `currentColor` so the parent's text color controls the badge tint, while
 * the inner tick is always white for contrast. Marked `aria-hidden` since
 * callers should pair it with adjacent text for meaning.
 */
export default function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path
        d="M4.8 8.2l2 2 4.4-4.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
