import type { CSSProperties } from 'react';
import { useId } from 'react';

interface UnionJackLensProps {
  className?: string;
  style?: CSSProperties;
  /** Starting rotation angle in degrees. Animation runs on mount. */
  fromDeg?: number;
  /** Ending rotation angle in degrees. */
  toDeg?: number;
  /** Animation duration in milliseconds. */
  durationMs?: number;
}

/**
 * Decorative Union-Jack-filled magnifying-glass lens. Used as a small marker
 * (e.g. on the keyboard-highlighted result row) — the same visual motif as the
 * site logo, scaled down. Set `aria-hidden` and `pointer-events: none` on the
 * wrapper since this is purely ornamental.
 *
 * The rotation is performed via SMIL `<animateTransform>` rather than CSS
 * transform: CSS transforms on SVG (or its wrapping element) cause the browser
 * to rasterize the element to a bitmap layer, which then samples blurry on
 * small lenses. SMIL keeps the rotation inside the SVG render pipeline so the
 * vectors stay sharp at every frame.
 */
export default function UnionJackLens({
  className,
  style,
  fromDeg = 0,
  toDeg = 0,
  durationMs = 720,
}: UnionJackLensProps) {
  const clipId = useId();
  const isAnimating = fromDeg !== toDeg;
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <g transform={`rotate(${isAnimating ? fromDeg : toDeg} 50 50)`}>
        {isAnimating && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from={`${fromDeg} 50 50`}
            to={`${toDeg} 50 50`}
            dur={`${durationMs}ms`}
            fill="freeze"
            calcMode="spline"
            keySplines="0 0 0.2 1"
          />
        )}
        <circle cx="50" cy="50" r="48" fill="var(--logo-navy)" />
        <clipPath id={clipId}>
          <circle cx="50" cy="50" r="36" />
        </clipPath>
        <g clipPath={`url(#${clipId})`}>
          <rect x="0" y="0" width="100" height="100" fill="#012169" />
          <path
            d="M0,0 L100,100 M100,0 L0,100"
            stroke="white"
            strokeWidth="14"
          />
          <path
            d="M0,0 L100,100 M100,0 L0,100"
            stroke="#C8102E"
            strokeWidth="5"
          />
          <path d="M50,0 V100 M0,50 H100" stroke="white" strokeWidth="24" />
          <path d="M50,0 V100 M0,50 H100" stroke="#C8102E" strokeWidth="14" />
        </g>
      </g>
    </svg>
  );
}
