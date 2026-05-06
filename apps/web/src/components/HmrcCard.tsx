import { Link } from '@tanstack/react-router';
import type { HmrcRow } from '../api/hmrc';
import { titleCase } from '../utils';
import RatingIcon from './RatingIcon';
import UnionJackLens from './UnionJackLens';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Single HMRC sponsor result card, rendered as a link into the company detail
 * route. Persists `window.scrollY` to sessionStorage on click so `HmrcResults`
 * can restore the list position on back-nav. When `isActive` is true the card
 * is given `view-transition-name: active-card`, which carves it out of the
 * `results-listing` snapshot so it can run its own slide animation while the
 * remaining cards fade.
 */
export default function HmrcCard({
  row,
  search,
  isActive,
  isHighlighted,
  lensRotation,
  onActivate,
}: {
  row: HmrcRow;
  search: string;
  isActive: boolean;
  isHighlighted: boolean;
  lensRotation: { from: number; to: number };
  onActivate: () => void;
}) {
  return (
    <Link
      to="/company/$id/$slug"
      params={{
        id: row.slugId,
        slug: row.nameSlug,
      }}
      search={{ search }}
      viewTransition={{ types: ['forward'] }}
      className="relative block no-underline py-2 -mx-4 px-4"
      style={{
        transition: 'none',
        ...(isActive ? { viewTransitionName: 'active-card' } : {}),
      }}
      onClick={() => {
        sessionStorage.setItem('hmrc-scroll-y', String(window.scrollY));
        sessionStorage.setItem('hmrc-active-id', row.slugId);
        sessionStorage.setItem(
          'hmrc-highlight',
          JSON.stringify({ search, slugId: row.slugId }),
        );
        onActivate();
      }}
    >
      {isHighlighted && (
        <span
          aria-hidden
          className="pointer-events-none absolute -left-2 top-3 block h-4 w-4"
        >
          <UnionJackLens
            className="h-full w-full"
            fromDeg={lensRotation.from}
            toDeg={lensRotation.to}
            durationMs={prefersReducedMotion() ? 0 : 720}
          />
        </span>
      )}
      <h3
        className={`heading-card text-base font-semibold ${isHighlighted ? 'text-(--logo-red)' : 'text-(--sea-ink)'}`}
      >
        {titleCase(row.organisationName)}
      </h3>
      <div className="mt-0.5">
        <RatingIcon rating={row.typeRating} />
      </div>
      <div className="mt-0.5">
        <p className="text-sm text-(--sea-ink-soft)">
          {[row.townCity, row.county].filter(Boolean).map(titleCase).join(', ')}
        </p>
        <p className="mt-0.5 truncate text-xs text-(--sea-ink-soft)">
          {titleCase(row.route)}
        </p>
      </div>
    </Link>
  );
}
