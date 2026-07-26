import { Link } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';

import type { HmrcRow } from '../api/hmrc';
import { ratingPriorityFirst } from '../lib/search/params';
import {
  formatLocation,
  previousNameText,
  skilledWorkerFirst,
  titleCase,
} from '../utils';
import RatingIcon from './RatingIcon';

/**
 * Single HMRC sponsor result card, rendered as a link into the company detail
 * route. Persists `window.scrollY` to sessionStorage on click so `HmrcResults`
 * can restore the list position on back-nav. When `isActive` is true the card
 * is given `view-transition-name: active-card`, which carves it out of the
 * `results-listing` snapshot so it can run its own slide animation while the
 * remaining cards fade. The keyboard-highlighted row only turns its name red —
 * the Union Jack marker that points at it lives on the rail in `HmrcResults`,
 * so the highlighted text is never shifted right.
 */
export default function HmrcCard({
  row,
  search,
  isActive,
  isHighlighted,
  onActivate,
}: {
  row: HmrcRow;
  search: string;
  isActive: boolean;
  isHighlighted: boolean;
  onActivate: () => void;
}) {
  const location = formatLocation(row.locality, row.region);
  const previousName = previousNameText(row.matchedPreviousName);
  // Defensive: an edge-cached payload minted before `licences` shipped has
  // none of these arrays — degrade instead of throwing the whole listing.
  const routes = row.routes ?? [];
  const licences = row.licences ?? [];
  // The chip's route leads by shared policy; the icon then shows THAT route's
  // own rating. Reading the rating from its own sorted list would advertise a
  // (route, rating) pair the company does not hold — e.g. an A-rated GBM
  // licence beside a B-rated Skilled Worker chip.
  // '' fallbacks keep the always-present rating/chip slots rendered (the
  // virtual list's fixedHeight assumes both) instead of throwing on an
  // unexpected payload — RatingIcon's local titleCase has no null guard.
  const chipRoute = skilledWorkerFirst(routes)[0] ?? '';
  const primaryRating =
    ratingPriorityFirst(
      licences.filter((l) => l.route === chipRoute).map((l) => l.rating),
    )[0] ??
    ratingPriorityFirst(row.typeRatings ?? [])[0] ??
    '';
  return (
    <Link
      to="/company/$slug"
      params={{
        slug: row.nameSlug,
      }}
      search={{ search }}
      // Row identity for the pop-transition resolver: namesake cards can
      // share an href, and the last-clicked slugId disambiguates the morph.
      data-slug-id={row.slugId}
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
      <h3
        className={`heading-card truncate text-base font-semibold ${isHighlighted ? 'text-(--logo-red)' : 'text-(--sea-ink)'}`}
      >
        {titleCase(row.organisationName)}
      </h3>
      {previousName && (
        // Single truncated line. The estimator counts this as exactly one
        // 16px line when a previous-name match exists (sentinel-measured), so
        // it must never wrap — and stays margin-free to match that count.
        <p className="truncate text-xs text-(--sea-ink-soft) italic">
          {previousName}
        </p>
      )}
      {/* Metadata. ≥sm: one inline row (rating · location · chip). <sm: each
          item stacks onto its own line (rating / location / chip) so nothing
          clips. The estimator in HmrcResults switches fixedHeight on this SAME
          `sm` (640px) breakpoint and counts the location as an extra stacked
          line only when <sm — keep the two in sync. Nothing wraps here; the
          location and chip truncate. */}
      <div className="mt-1 flex flex-col items-start gap-y-1 text-sm text-(--sea-ink-soft) sm:flex-row sm:items-center sm:gap-x-3">
        <span className="shrink-0 whitespace-nowrap">
          <RatingIcon rating={primaryRating} />
        </span>
        {location && (
          <span className="flex max-w-full min-w-0 items-center gap-1.5">
            <MapPin size={14} className="shrink-0" />
            <span className="truncate">{location}</span>
          </span>
        )}
        <span className="max-w-full shrink-0 truncate rounded-md bg-(--chip-bg) px-2 py-0.5 font-mono text-xs whitespace-nowrap text-(--sea-ink-soft) ring-1 ring-(--chip-line) ring-inset">
          {titleCase(chipRoute)}
          {routes.length > 1 ? ` +${routes.length - 1}` : ''}
        </span>
      </div>
    </Link>
  );
}
