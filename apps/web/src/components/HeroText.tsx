import { Link } from '@tanstack/react-router';

import { FILTER_DIMENSION_COUNT } from '../lib/search/params';
import Odometer from './Odometer';

import styles from './HeroText.module.css';

/**
 * Empty-state landing hero — a big, confident stat (Grok / Colossus style): the
 * live sponsor count abbreviated as "<n>K+" in high-contrast type over a muted
 * supporting label, plus a chip row broadcasting the filter capability that
 * links to /filters. The number is the petrol-pump <Odometer>, rolling up to
 * the live count. Rendered only while the search input is empty, so its
 * entrance animation runs on mount and unmounts the moment the user types.
 * Theme-aware via --sea-ink tokens; honours reduced-motion.
 */
// Conservative floor (in thousands) shown if the live count is unavailable (cold
// client nav or a failed fetch). The real figure is above this, so "<n>K+" stays true.
const FALLBACK_THOUSANDS = 100;

// Mirrors /filters' section titles (minus Sort, which isn't a filter).
const FACETS = [
  'Visa route',
  'Licence',
  'Location',
  'Industry',
  'Company status',
  'Company type',
  'Incorporated',
  'Signals',
];

export default function HeroText({ count }: { count?: number }) {
  // Whole thousands, floored, so "<n>K+" is always a truthful lower bound of the
  // live count (e.g. 114,145 → "114K+").
  const thousands =
    count && count >= 1000 ? Math.floor(count / 1000) : FALLBACK_THOUSANDS;
  return (
    <>
      <h2
        className={styles.hero}
        data-hero-stat
        aria-label={`${(thousands * 1000).toLocaleString('en-GB')}+ licensed UK visa sponsors`}
      >
        <span className={styles.streaks} aria-hidden="true" />
        <span className={styles.figure} aria-hidden="true">
          <Odometer value={thousands} durationMs={1600} delayMs={900} />
          <span className={styles.suffix}>K+</span>
        </span>

        <span className={styles.subline} aria-hidden="true">
          licensed UK visa sponsors
        </span>
      </h2>
      <Link
        to="/filters"
        className={styles.filtersLink}
        aria-label={`Filter the register ${FILTER_DIMENSION_COUNT} ways`}
      >
        <span className={styles.filtersCount}>
          {FILTER_DIMENSION_COUNT} filters
        </span>
        {FACETS.map((facet) => (
          <span key={facet} className={styles.facet}>
            {facet}
          </span>
        ))}
        <span className={styles.filtersGo} aria-hidden="true">
          →
        </span>
      </Link>
    </>
  );
}
