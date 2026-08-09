import {
  CELESTIAL,
  CLOUDS,
  INK_STROKES,
  LANDMARKS,
  LANDMARK_ORDER,
  MOON_PATH,
  STARS,
  SUN_R,
  SUN_RAYS,
  VIEW_H,
  VIEW_W,
  r,
} from '@ss/skyline';
import type { Fill, Ink, Landmark, Mark } from '@ss/skyline';
import { useEffect, useId, useRef, useState } from 'react';

import { useIsDark } from '../hooks/useIsDark';

import styles from './LondonSkyline.module.css';

interface LondonSkylineProps {
  className?: string;
}

/** Paint names from the shared geometry, resolved to this stylesheet's classes. */
const INK_CLASS: Record<Ink, string> = {
  limestone: styles.limestone,
  roofSlate: styles.roofSlate,
  clockBlue: styles.clockBlue,
  gold: styles.gold,
  steel: styles.steel,
  capsuleGlass: styles.capsuleGlass,
  portland: styles.portland,
  lead: styles.lead,
  bridgeBlue: styles.bridgeBlue,
  shardGlass: styles.shardGlass,
  gherkinGlass: styles.gherkinGlass,
};
const FILL_CLASS: Record<Fill, string> = {
  tint: styles.tint,
  wash: styles.wash,
  face: styles.dialFace,
};

/** One landmark's line work, with a clip path defined for any mark that asks for one
 * (the Gherkin's lattice). Marks name their own ink only where it differs from the
 * group's, so the group keeps setting the colour every child inherits. */
function Landmark({ landmark, uid }: { landmark: Landmark; uid: string }) {
  const clips = [
    ...new Set(landmark.marks.map((m: Mark) => m.clip).filter(Boolean)),
  ] as string[];
  const clipId = (d: string) =>
    `${landmark.id}-clip-${clips.indexOf(d)}-${uid}`;
  return (
    <g className={INK_CLASS[landmark.ink]}>
      {clips.map((d) => (
        <clipPath key={d} id={clipId(d)}>
          <path d={d} />
        </clipPath>
      ))}
      {landmark.marks.map((m: Mark, i) => (
        <path
          // Paths repeat across a landmark (Tower Bridge draws its tower twice), so
          // position is the only stable key.
          key={`${i}-${m.d}`}
          d={m.d}
          className={
            [m.ink && INK_CLASS[m.ink], m.fill && FILL_CLASS[m.fill]]
              .filter(Boolean)
              .join(' ') || undefined
          }
          strokeWidth={m.width}
          transform={m.dx ? `translate(${m.dx} 0)` : undefined}
          clipPath={m.clip ? `url(#${clipId(m.clip)})` : undefined}
        />
      ))}
    </g>
  );
}

/**
 * Clean single-stroke line drawing of the London skyline — Big Ben, the London
 * Eye, St Paul's Cathedral, Tower Bridge, the Shard and the Gherkin — sitting on
 * a shared ground line, with a sun + blue ink-wash sky (light mode) / crescent
 * moon + stars (dark mode) behind them. Strokes resolve from `currentColor`
 * per element: light mode paints each landmark via the module's real-world
 * palette classes (coloured strokes + translucent fill washes), dark mode
 * reverts them all to one faint ink outline; used as the faint footer
 * watermark.
 */
export default function LondonSkyline({ className }: LondonSkylineProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [mounted, setMounted] = useState(false);
  const [inView, setInView] = useState(false);
  // Bumped on each light<->dark flip; keys the celestial groups so they remount
  // and re-run their fill animation (display:none -> shown alone won't restart it).
  // A counter (not `isDark` itself) keeps the SSR/first-paint key stable — keying
  // on isDark directly would hydration-mismatch.
  const isDark = useIsDark();
  const [themeFlips, setThemeFlips] = useState(0);
  const wasDark = useRef(isDark);
  const smokeFreqRef = useRef<SVGAnimateElement>(null);
  const smokeDriftRef = useRef<SVGAnimateElement>(null);
  const smokeScaleRef = useRef<SVGAnimateElement>(null);
  const smokeArmedRef = useRef(false);
  const smokePlayingRef = useRef(false);
  const smokeTimerRef = useRef<number | undefined>(undefined);
  const smokeQueueRef = useRef<(() => void) | null>(null);
  const inkGroupRef = useRef<SVGGElement>(null);
  // Per-instance ids: url(#…) resolves document-globally, so fixed ids would
  // bind every instance's ink to the first mount's filter/mask.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const smokeFilterId = `ink-smoke-${uid}`;
  const sunMaskId = `ink-sun-reserve-${uid}`;

  // One observer, two state machines, every batched entry processed so no
  // crossing is dropped: the sky-fill entrance arms at 35% visible (reset once
  // fully out of view); the smoke burst arms at 60% (re-armed below 15%).
  useEffect(() => {
    setMounted(true);
    const el = ref.current;
    if (!el) return;

    /** Live visible fraction of the skyline, independent of observer batching. */
    const visibleRatio = () => {
      const rect = el.getBoundingClientRect();
      if (!rect.height) return 0;
      return (
        Math.max(
          0,
          Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
        ) / rect.height
      );
    };

    /** Ends an in-flight burst and returns the ink to crisp vector paint. */
    const stopSmoke = () => {
      window.clearTimeout(smokeTimerRef.current);
      if (!smokePlayingRef.current) return;
      smokePlayingRef.current = false;
      smokeScaleRef.current?.endElement();
      smokeFreqRef.current?.endElement();
      smokeDriftRef.current?.endElement();
      inkGroupRef.current?.removeAttribute('filter');
    };

    // Queue a burst behind a settle beat: re-checking visibility, theme and
    // motion 600ms later stops load-time layout shifts and mid-overlay theme
    // swaps from burning the burst while nobody can see it.
    const queueSmoke = () => {
      window.clearTimeout(smokeTimerRef.current);
      smokeTimerRef.current = window.setTimeout(() => {
        // restarting mid-flight snaps billowed ink back to crisp for a frame
        if (smokePlayingRef.current) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches)
          return;
        // the ink layer is display:none in dark mode — nothing to animate
        if (document.documentElement.classList.contains('dark')) return;
        if (visibleRatio() < 0.6) {
          smokeArmedRef.current = false;
          return;
        }
        smokePlayingRef.current = true;
        // Attached only while the burst plays — at rest the sky stays direct
        // vector paint instead of a rasterizing filter pipeline.
        inkGroupRef.current?.setAttribute('filter', `url(#${smokeFilterId})`);
        smokeFreqRef.current?.beginElement();
        smokeDriftRef.current?.beginElement();
        smokeScaleRef.current?.beginElement();
      }, 600);
    };
    smokeQueueRef.current = queueSmoke;

    const scaleAnim = smokeScaleRef.current;
    const onSmokeEnd = () => {
      smokePlayingRef.current = false;
      inkGroupRef.current?.removeAttribute('filter');
    };
    scaleAnim?.addEventListener('endEvent', onSmokeEnd);

    // A live reduced-motion flip halts an in-flight burst, matching the CSS
    // animations that stop when their media block no longer applies.
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = () => {
      if (motionQuery.matches) stopSmoke();
    };
    motionQuery.addEventListener('change', onMotionChange);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const ratio = entry.intersectionRatio;
          if (ratio >= 0.35) setInView(true);
          else if (ratio <= 0) setInView(false);
          if (ratio >= 0.6 && !smokeArmedRef.current) {
            smokeArmedRef.current = true;
            queueSmoke();
          } else if (ratio <= 0.15) {
            smokeArmedRef.current = false;
          }
        }
      },
      { threshold: [0, 0.15, 0.35, 0.6] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      motionQuery.removeEventListener('change', onMotionChange);
      scaleAnim?.removeEventListener('endEvent', onSmokeEnd);
      window.clearTimeout(smokeTimerRef.current);
      smokeQueueRef.current = null;
    };
  }, [smokeFilterId]);

  // A light<->dark switch replays the sky-fill via the keyed remount below.
  useEffect(() => {
    if (wasDark.current !== isDark) {
      wasDark.current = isDark;
      setThemeFlips((n) => n + 1);
    }
  }, [isDark]);

  // Replay the smoke on theme flips; the queue re-checks visibility, theme and
  // motion live, so it only plays when the skyline is truly on show in light.
  useEffect(() => {
    if (themeFlips === 0) return;
    smokeQueueRef.current?.();
  }, [themeFlips]);

  return (
    <svg
      ref={ref}
      className={[
        styles.skyline,
        className,
        mounted && styles.js,
        inView && styles.animate,
      ]
        .filter(Boolean)
        .join(' ')}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMax meet"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="London skyline"
      data-london-skyline
      data-sun-x={CELESTIAL.cx}
      data-sun-y={CELESTIAL.cy}
    >
      {/* Sky ink — light mode only; always present (no entrance animation).
          The mask reserves a blank circle around the sun so ink never shows
          through the disc while its entrance fill is still transparent. The
          filter billows the ink like smoke for ~3s per burst — queueSmoke
          attaches it to the group only while playing, so the resting stroke
          is direct vector paint; masking happens after filtering so the sun's
          reserve stays fixed while the ink curls around it. */}
      <mask id={sunMaskId}>
        <rect width={VIEW_W} height={VIEW_H} fill="#ffffff" stroke="none" />
        <circle
          cx={CELESTIAL.cx}
          cy={CELESTIAL.cy}
          r={SUN_R + 12}
          fill="#000000"
          stroke="none"
        />
      </mask>
      <filter id={smokeFilterId} x="-5%" y="-20%" width="110%" height="140%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.011 0.019"
          numOctaves={3}
          seed={7}
          result="n"
        >
          <animate
            ref={smokeFreqRef}
            attributeName="baseFrequency"
            begin="indefinite"
            dur="3s"
            values="0.011 0.019;0.016 0.027"
            fill="freeze"
          />
        </feTurbulence>
        {/* Pans the noise field one way for the whole burst, so the dissolve
            never retraces the swell — the smoke drifts instead of reversing. */}
        <feOffset in="n" dx={0} dy={0} result="np">
          <animate
            ref={smokeDriftRef}
            attributeName="dx"
            begin="indefinite"
            dur="3s"
            values="0;36"
            fill="freeze"
          />
        </feOffset>
        <feDisplacementMap
          in="SourceGraphic"
          in2="np"
          scale={0}
          xChannelSelector="R"
          yChannelSelector="G"
        >
          <animate
            ref={smokeScaleRef}
            attributeName="scale"
            begin="indefinite"
            dur="3s"
            values="0;75;0"
            keyTimes="0;0.3;1"
            calcMode="spline"
            keySplines="0.25 0 0.45 1;0.3 0 0.35 1"
            fill="freeze"
          />
        </feDisplacementMap>
      </filter>
      <g ref={inkGroupRef} className={styles.ink} mask={`url(#${sunMaskId})`}>
        {INK_STROKES.map((s) => (
          <path
            key={s.key}
            d={s.d}
            fillRule={s.fillRule}
            fillOpacity={s.opacity}
          />
        ))}
      </g>

      {/* Sun — light mode only (disc fills in gradually + rays) */}
      <g key={`sun-${themeFlips}`} className={styles.sun}>
        <circle
          className={styles.sunDisc}
          cx={CELESTIAL.cx}
          cy={CELESTIAL.cy}
          r={SUN_R}
          fill="#ffffff"
        />
        {SUN_RAYS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      {/* Crescent moon (gradual fill) + stars (blink in) — dark mode only */}
      <g key={`moon-${themeFlips}`} className={styles.moon}>
        <path className={styles.moonDisc} d={MOON_PATH} fill="#ffffff" />
        {STARS.map((d, i) => (
          <path
            key={d}
            className={styles.star}
            d={d}
            fill="#ffffff"
            style={{ animationDelay: `${0.15 + i * 0.12}s` }}
          />
        ))}
      </g>

      {/* Clouds — light mode only (drift in) */}
      <g key={`clouds-${themeFlips}`} className={styles.clouds}>
        {CLOUDS.map((c) => (
          <g
            key={`${c.x},${c.y}`}
            transform={`translate(${c.x},${c.y}) scale(${c.scale})`}
          >
            <g
              className={styles.cloud}
              style={{ animationDelay: `${c.delay}s` }}
            >
              <path d={c.path} fill="#ffffff" strokeWidth={r(2 / c.scale)} />
            </g>
          </g>
        ))}
      </g>

      {/* Big Ben, the London Eye, St Paul's, Tower Bridge, the Shard and the
          Gherkin, left to right along the ground line. */}
      {LANDMARK_ORDER.map((id) => (
        <Landmark key={id} landmark={LANDMARKS[id]} uid={uid} />
      ))}
    </svg>
  );
}
