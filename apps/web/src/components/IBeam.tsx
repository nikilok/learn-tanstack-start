/**
 * Grayscale, outlined I-beam cursor shown over editable text fields (paired with
 * the Union-Jack badge in `UnionJackCursor`). Theme-aware: an ink-coloured body
 * over a surface-coloured rim, so the outline stays visible in both light and
 * dark mode. Sized to fill its wrapper; centred on the pointer by the caller.
 */
export default function IBeam() {
  return (
    <svg
      viewBox="0 0 14 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', width: '100%', height: '100%' }}
      aria-hidden="true"
    >
      {/* Rim drawn first (wider, behind); body on top. `stroke` is set via CSS,
          not the attribute, because only the property accepts var(). */}
      <path
        d="M4 3 H10 M7 3 V19 M4 19 H10"
        style={{ stroke: 'var(--surface)' }}
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 3 H10 M7 3 V19 M4 19 H10"
        style={{ stroke: 'var(--sea-ink)' }}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
