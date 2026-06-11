import { Link } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';

import type { HmrcRow } from '../api/hmrc';
import { formatLocation, titleCase } from '../utils';
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
      className="relative -mx-4 block px-4 py-2 no-underline"
      style={{
        transition: 'none',
        ...(isActive ? { viewTransitionName: 'active-card' } : {}),
      }}
      onClick={() => {
        // Persist only a real (>=1px) scroll; a "0"/sub-pixel value is truthy but
        // floors to 0 on read, so it would strand the pre-hydration hide with no
        // consumer to clear it. Threshold matches the reader's `parseInt > 0`.
        if (window.scrollY >= 1) {
          sessionStorage.setItem('hmrc-scroll-y', String(window.scrollY));
        } else {
          sessionStorage.removeItem('hmrc-scroll-y');
        }
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
          className="pointer-events-none absolute top-3 -left-2 block h-4 w-4"
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
      {row.matchedPreviousName && (
        // No vertical margins: the height estimator in HmrcResults measures
        // this line as lineCount * 16px, so any margin here would desync it
        <p className="text-xs text-(--sea-ink-soft) italic">
          Previously {titleCase(row.matchedPreviousName)}
        </p>
      )}
      <div className="mt-0.5">
        <RatingIcon rating={row.typeRating} />
      </div>
      <div className="mt-0.5">
        {formatLocation(row.locality, row.region) && (
          // Single truncated line: the height estimator in HmrcResults counts
          // this as exactly one line when a location exists, so it must never
          // wrap (the inline icon steals width the estimator can't see)
          <p className="flex items-center gap-1.5 text-sm text-(--sea-ink-soft)">
            <MapPin size={14} className="shrink-0" />
            <span className="truncate">
              {formatLocation(row.locality, row.region)}
            </span>
          </p>
        )}
        <p className="mt-0.5 truncate text-xs text-(--sea-ink-soft)">
          {titleCase(row.route)}
        </p>
      </div>
    </Link>
  );
}
