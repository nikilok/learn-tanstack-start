import type { CSSProperties } from 'react';

import SegmentDisplay from './SegmentDisplay';

import styles from './HeroText.module.css';

/**
 * Empty-state landing hero — kinetic number focus. Rendered only while the
 * search input is empty, so its entrance animation runs on mount and unmounts
 * the moment the user types. The "140+" figure is the focal point: oversized,
 * with a scale/blur-in entrance over a slowly drifting brand aurora, while the
 * surrounding words rise in with a per-word stagger. Theme-aware via CSS
 * custom properties; honours reduced-motion.
 */
// Conservative floor shown if the live count is unavailable (cold client nav or
// a failed fetch). The real figure is well above this, so "<floor>+" stays true.
const FALLBACK_COUNT = 100_000;

export default function HeroText({ count }: { count?: number }) {
  // Round down to a clean thousand (or the conservative fallback), so the real
  // count is always higher than shown and the trailing "+" stays truthful.
  const target =
    count && count >= 1000 ? Math.floor(count / 1000) * 1000 : FALLBACK_COUNT;
  return (
    <h2
      className={styles.hero}
      aria-label={`Explore ${target.toLocaleString('en-GB')}+ licensed UK visa sponsors`}
    >
      <span className={styles.line} aria-hidden="true">
        <span className={styles.word} style={{ '--i': 0 } as CSSProperties}>
          Explore
        </span>
      </span>

      <span className={styles.figureLine} aria-hidden="true">
        <span className={styles.aurora} />
        <span className={styles.figure}>
          <SegmentDisplay value={target} durationMs={1600} delayMs={900} />
        </span>
      </span>

      <span className={styles.line} aria-hidden="true">
        <span className={styles.word} style={{ '--i': 1 } as CSSProperties}>
          licensed
        </span>{' '}
        <span className={styles.word} style={{ '--i': 2 } as CSSProperties}>
          UK
        </span>{' '}
        <span className={styles.word} style={{ '--i': 3 } as CSSProperties}>
          visa
        </span>{' '}
        <span className={styles.word} style={{ '--i': 4 } as CSSProperties}>
          sponsors
        </span>
      </span>
    </h2>
  );
}
