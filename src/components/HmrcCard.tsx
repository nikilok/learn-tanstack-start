import { Link } from '@tanstack/react-router';
import type { HmrcRow } from '../api/hmrc';
import { titleCase } from '../utils';
import RatingIcon from './RatingIcon';
import Tooltip from './Tooltip';

export default function HmrcCard({ row }: { row: HmrcRow }) {
  return (
    <Link
      to="/company/$name"
      params={{ name: encodeURIComponent(row.organisationName) }}
      className="glass block rounded-lg p-4 transition-shadow hover:shadow-md"
      onClick={() =>
        sessionStorage.setItem('hmrc-scroll-y', String(window.scrollY))
      }
    >
      <Tooltip text={titleCase(row.organisationName)}>
        <h3 className="heading-card cursor-pointer truncate text-base font-semibold text-(--sea-ink)">
          {titleCase(row.organisationName)}
        </h3>
      </Tooltip>
      <div className="mt-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Tooltip
            text={[row.townCity, row.county]
              .filter(Boolean)
              .map(titleCase)
              .join(', ')}
          >
            <p className="cursor-pointer truncate text-sm text-(--sea-ink-soft)">
              {[row.townCity, row.county]
                .filter(Boolean)
                .map(titleCase)
                .join(', ')}
            </p>
          </Tooltip>
          <Tooltip text={titleCase(row.route)}>
            <p className="mt-1 cursor-pointer truncate text-xs text-(--sea-ink-soft)">
              {titleCase(row.route)}
            </p>
          </Tooltip>
        </div>
        <div className="shrink-0">
          <RatingIcon rating={row.typeRating} />
        </div>
      </div>
    </Link>
  );
}
