import type { CSSProperties } from 'react';

import styles from './HeroText.module.css';

/**
 * Empty-state landing hero — kinetic number focus. Rendered only while the
 * search input is empty, so its entrance animation runs on mount and unmounts
 * the moment the user types. The "140+" figure is the focal point: oversized,
 * with a scale/blur-in entrance over a slowly drifting brand aurora, while the
 * surrounding words rise in with a per-word stagger. Theme-aware via CSS
 * custom properties; honours reduced-motion.
 */
export default function HeroText({ count }: { count: number }) {
  // Round down to a clean thousand so "over N" stays truthful and the figure
  // doesn't jitter on small ingestion deltas.
  const figure = (
    count >= 1000 ? Math.floor(count / 1000) * 1000 : count
  ).toLocaleString('en-GB');
  return (
    <h2
      className={styles.hero}
      aria-label={`Explore ${figure} licensed UK visa sponsors`}
    >
      <span className={styles.line} aria-hidden="true">
        <span className={styles.word} style={{ '--i': 0 } as CSSProperties}>
          Explore
        </span>
      </span>

      <span className={styles.figureLine} aria-hidden="true">
        <span className={styles.aurora} />
        <span className={styles.figure}>{figure}</span>
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
