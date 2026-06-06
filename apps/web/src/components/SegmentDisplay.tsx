import { useEffect, useRef, useState } from 'react';

import styles from './SegmentDisplay.module.css';

// 7-segment geometry in a 24×44 viewBox. Each segment is a flat hexagon so the
// ends meet at mitred corners like a real LCD.
const W = 24;
const H = 44;
const HT = 2; // half thickness
const PAD = 2; // inset from the edges
const GAP = 1; // gap between touching segments
const X0 = PAD;
const X1 = W - PAD;
const A_Y = PAD + HT;
const G_Y = H / 2;
const D_Y = H - PAD - HT;

const h = (cy: number) =>
  `${X0},${cy} ${X0 + HT},${cy - HT} ${X1 - HT},${cy - HT} ${X1},${cy} ${X1 - HT},${cy + HT} ${X0 + HT},${cy + HT}`;
const v = (cx: number, y0: number, y1: number) =>
  `${cx},${y0} ${cx + HT},${y0 + HT} ${cx + HT},${y1 - HT} ${cx},${y1} ${cx - HT},${y1 - HT} ${cx - HT},${y0 + HT}`;

const SEGMENTS: { id: string; points: string }[] = [
  { id: 'a', points: h(A_Y) },
  { id: 'b', points: v(X1, A_Y + HT + GAP, G_Y - HT - GAP) },
  { id: 'c', points: v(X1, G_Y + HT + GAP, D_Y - HT - GAP) },
  { id: 'd', points: h(D_Y) },
  { id: 'e', points: v(X0, G_Y + HT + GAP, D_Y - HT - GAP) },
  { id: 'f', points: v(X0, A_Y + HT + GAP, G_Y - HT - GAP) },
  { id: 'g', points: h(G_Y) },
];

const DIGIT_ON: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

/** One 7-segment cell: all segments drawn faint (ghost "8"), active ones lit. */
function Digit({ ch }: { ch: string }) {
  const on = DIGIT_ON[ch] ?? '';
  return (
    <svg
      className={styles.digit}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      focusable="false"
    >
      {SEGMENTS.map((s) => (
        <polygon
          key={s.id}
          points={s.points}
          className={on.includes(s.id) ? styles.on : styles.seg}
        />
      ))}
    </svg>
  );
}

/** A "+" drawn in the same segment style (lit middle bar + lit centre column). */
function Plus() {
  return (
    <svg
      className={styles.digit}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      focusable="false"
    >
      <polygon className={styles.on} points={h(G_Y)} />
      <polygon className={styles.on} points={v(W / 2, A_Y, D_Y)} />
    </svg>
  );
}

/** Tween an integer to `target` (ease-out) on increase; SSR-safe, reduced-motion aware. */
function useCountUp(target: number, durationMs: number, delayMs: number) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (target === fromRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const from = fromRef.current;
    let raf = 0;
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const t = Math.min((ts - start) / durationMs, 1);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(step);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [target, durationMs, delayMs]);
  return value;
}

/**
 * Calculator-style 7-segment readout that counts up to `value`. Each digit
 * shows a faint ghost "8" with the lit segments on top; the number rolls up
 * through the segments on the SSR-fallback → live-count change. Trailing "+"
 * is rendered in the same style.
 */
export default function SegmentDisplay({
  value,
  durationMs = 1600,
  delayMs = 900,
}: {
  value: number;
  durationMs?: number;
  delayMs?: number;
}) {
  const display = useCountUp(value, durationMs, delayMs);
  const chars = Math.round(display).toLocaleString('en-GB').split('');
  return (
    <span className={styles.display} aria-hidden="true">
      {chars.map((ch, i) =>
        ch >= '0' && ch <= '9' ? (
          <Digit key={`${i}-${ch}`} ch={ch} />
        ) : (
          <span key={`${i}-${ch}`} className={styles.sep}>
            {ch}
          </span>
        ),
      )}
      <Plus />
    </span>
  );
}
