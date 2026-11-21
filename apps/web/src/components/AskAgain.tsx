import { askAgainWhen } from '../lib/ask/cooldown';

import styles from './AskAgain.module.css';
import examples from './AskExamples.module.css';

/**
 * The hero's line for a device waiting out a cooldown (lib/ask/cooldown):
 * when it may ask again, under the filters row, which stands in for the
 * example questions meanwhile. The ring is the examples' own, at rest.
 * Rendered in the browser only: the time is said in the visitor's own zone.
 */
export default function AskAgain({ until }: { until: number }) {
  return (
    <p className={styles.again} role="status">
      <span className={`${examples.mark} ${styles.rest}`} aria-hidden="true" />
      You can ask again after {askAgainWhen(until)}
    </p>
  );
}
