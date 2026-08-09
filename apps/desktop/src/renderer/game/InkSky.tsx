import { INK_COLOR, INK_STROKES, VIEW_W } from '@ss/skyline';
import { useEffect, useRef, useState } from 'react';

/** How far down the skyline's viewBox the ink sweep reaches. Cropping to it keeps the
 * brushwork at the top of the sky instead of scaling the whole 600-unit box down. */
const INK_BAND = 300;
/**
 * One full breath of the sweep. Slow, because it runs the whole time it is up — but not so
 * slow that a glance never catches it moving, which is what 13s was.
 */
const BREATH = '7s';

/**
 * The sumi-e brush sweep from the site's footer, painted across the game's sky in light
 * mode — and, unlike the footer's, always moving: it swells and settles on a loop for as
 * long as the screen is up, so the sky is alive behind the run rather than a still.
 *
 * It is an SVG layer behind the canvas rather than more drawing on it because the motion
 * is an feTurbulence displacement, which canvas 2D has no answer to at any sensible cost.
 */
export function InkSky({ dark }: { dark: boolean }) {
  // Still — no filter at all, just the footer's own sky — when motion is not wanted, and
  // when nobody is looking. This screen can be up for many minutes in a window behind
  // something else, and the displacement map is a full-width raster every frame; there is
  // nothing to gain from running it for an audience of no one.
  const [still, setStill] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setStill(query.matches || document.hidden);
    sync();
    query.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      query.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  /**
   * Started by hand rather than by `begin="0s"`.
   *
   * This layer is only in the document while the run is in daylight, so on a run that
   * starts at night it is inserted long after the document's own timeline began — and a
   * SMIL animation whose start time is already in the past does not play when its element
   * arrives late. Measured: the displacement sat at exactly 0 for as long as it was
   * sampled, so the sweep was mounted, filtered, and completely still.
   */
  const runningRef = useRef<SVGAnimationElement[]>([]);
  useEffect(() => {
    if (dark || still) return;
    // A frame later, not in the effect itself. The layer has only just been inserted at
    // this point and its SVG timeline has not started — measured at getCurrentTime() ≈ 0 —
    // and a begin issued against a clock that is not running yet is dropped on the floor.
    // Calling it once the timeline is live is the difference between a sweep that breathes
    // and one that sits at exactly zero displacement for as long as you care to watch.
    const id = requestAnimationFrame(() => {
      for (const a of runningRef.current) a?.beginElement();
    });
    return () => cancelAnimationFrame(id);
  }, [dark, still]);
  const collect = (el: SVGElement | null, i: number) => {
    if (el) runningRef.current[i] = el as SVGAnimationElement;
  };

  // Dark mode has no ink at all, exactly as the footer's sky doesn't.
  if (dark) return null;

  return (
    <svg
      className="ink-sky"
      viewBox={`0 0 ${VIEW_W} ${INK_BAND}`}
      preserveAspectRatio="xMidYMin meet"
      xmlns="http://www.w3.org/2000/svg"
      fill={INK_COLOR}
      stroke="none"
      aria-hidden="true"
    >
      <filter id="game-ink-smoke" x="-5%" y="-20%" width="110%" height="140%">
        {/* Two octaves rather than the footer's three: this filter runs on every frame
            for as long as the screen is up, and the third only shows at a burst's peak. */}
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.011 0.019"
          numOctaves={2}
          seed={7}
          result="n"
        >
          <animate
            ref={(el) => collect(el, 0)}
            attributeName="baseFrequency"
            begin="indefinite"
            dur={BREATH}
            repeatCount="indefinite"
            values="0.011 0.019;0.016 0.027;0.011 0.019"
            keyTimes="0;0.5;1"
            calcMode="spline"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
          />
        </feTurbulence>
        {/* Pans the noise field and brings it back, easing to a stop at the turn. A
            one-way pan would have to jump home at the loop point; easing through zero
            velocity is what keeps the drift from reading as a rewind. */}
        <feOffset in="n" dx={0} dy={0} result="np">
          <animate
            ref={(el) => collect(el, 1)}
            attributeName="dx"
            begin="indefinite"
            dur={BREATH}
            repeatCount="indefinite"
            values="0;30;0"
            keyTimes="0;0.5;1"
            calcMode="spline"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
          />
        </feOffset>
        {/* Passes back through zero each cycle, so the sweep keeps returning to the crisp
            shape the footer paints and the swell reads as breathing, not a wobble. */}
        <feDisplacementMap
          in="SourceGraphic"
          in2="np"
          scale={0}
          xChannelSelector="R"
          yChannelSelector="G"
        >
          <animate
            ref={(el) => collect(el, 2)}
            attributeName="scale"
            begin="indefinite"
            dur={BREATH}
            repeatCount="indefinite"
            values="0;46;0"
            keyTimes="0;0.5;1"
            calcMode="spline"
            keySplines="0.3 0 0.5 1;0.5 0 0.7 1"
          />
        </feDisplacementMap>
      </filter>
      <g filter={still ? undefined : 'url(#game-ink-smoke)'}>
        {INK_STROKES.map((s) => (
          <path
            key={s.key}
            d={s.d}
            fillRule={s.fillRule}
            fillOpacity={s.opacity}
          />
        ))}
      </g>
    </svg>
  );
}
