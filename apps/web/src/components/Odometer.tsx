import { type CSSProperties, useEffect, useRef, useState } from 'react';

import styles from './Odometer.module.css';

// Extra full 0-9 spins for the units place; one fewer per place to the left, so
// trailing digits blur-spin like a petrol pump while leading digits just creep.
const UNITS_SPINS = 3;

/** Digit sequence a wheel rolls through, from `fromD` up to `toD` plus `spins` full cycles. */
function buildReel(fromD: number, toD: number, spins: number): number[] {
  const steps = spins * 10 + ((toD - fromD + 10) % 10);
  return Array.from({ length: steps + 1 }, (_, k) => (fromD + k) % 10);
}

/**
 * Petrol-pump style number: on each increasing value change every digit rolls
 * up to its target, trailing digits spinning through extra cycles for the
 * mechanical roll. SSR-safe (renders the value statically until it changes) and
 * honours reduced-motion (the wheels jump straight to the value).
 */
export default function Odometer({
  value,
  durationMs = 1500,
  delayMs = 0,
  glyphClassName,
}: {
  value: number;
  durationMs?: number;
  delayMs?: number;
  // Optional class applied to each leaf glyph (digit + separator); the column
  // index is exposed as `--col` so callers can phase per-glyph effects.
  glyphClassName?: string;
}) {
  const prevRef = useRef(value);
  const [rolled, setRolled] = useState(false);
  const from = prevRef.current;

  useEffect(() => {
    if (value === prevRef.current) return;
    setRolled(false);
    const raf = requestAnimationFrame(() => setRolled(true));
    const settle = setTimeout(
      () => {
        prevRef.current = value;
      },
      delayMs + durationMs + 50,
    );
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [value, durationMs, delayMs]);

  const toStr = Math.round(value).toLocaleString('en-GB');
  const fromStr = Math.round(from)
    .toLocaleString('en-GB')
    .padStart(toStr.length, '0');
  const totalDigits = toStr.replace(/\D/g, '').length;
  let seenDigits = 0;

  return (
    <span className={styles.odometer} aria-hidden="true">
      {toStr.split('').map((ch, i) => {
        const key = `${i}-${ch}`;
        if (ch < '0' || ch > '9') {
          return (
            <span
              key={key}
              className={`${styles.sep} ${glyphClassName ?? ''}`}
              style={{ '--col': i } as CSSProperties}
            >
              {ch}
            </span>
          );
        }
        const placeFromRight = totalDigits - 1 - seenDigits;
        seenDigits += 1;
        const toD = Number(ch);
        const fromCh = fromStr[i];
        const fromD = fromCh >= '0' && fromCh <= '9' ? Number(fromCh) : toD;
        const seq = buildReel(
          fromD,
          toD,
          Math.max(0, UNITS_SPINS - placeFromRight),
        );
        const offset = rolled ? seq.length - 1 : 0;
        return (
          <span
            key={key}
            className={styles.reel}
            style={{ '--col': i } as CSSProperties}
          >
            <span
              className={styles.reelInner}
              style={{
                transform: `translateY(-${offset}em)`,
                transitionDuration: `${durationMs}ms`,
                transitionDelay: `${delayMs}ms`,
              }}
            >
              {seq.map((d, k) => (
                <span
                  key={k}
                  className={`${styles.digit} ${glyphClassName ?? ''}`}
                >
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
