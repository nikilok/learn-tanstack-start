import { Link } from '@tanstack/react-router';
import type { HmrcRow } from '../api/hmrc';
import { slugify, titleCase } from '../utils';
import RatingIcon from './RatingIcon';

export default function HmrcCard({
  row,
  search,
}: {
  row: HmrcRow;
  search: string;
}) {
  return (
    <Link
      to="/company/$id/$slug"
      params={{
        id: row.slugId,
        slug: slugify(row.organisationName),
      }}
      search={{ search }}
      className="block no-underline rounded-lg bg-(--sponsor-card-bg) shadow-(--shadow-card) p-4 transition-shadow hover:shadow-(--shadow-card-full)"
      onClick={() =>
        sessionStorage.setItem('hmrc-scroll-y', String(window.scrollY))
      }
    >
      <h3 className="heading-card truncate text-base font-semibold text-(--sea-ink)">
        {titleCase(row.organisationName)}
      </h3>
      <div className="mt-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm text-(--sea-ink-soft)">
            {[row.townCity, row.county]
              .filter(Boolean)
              .map(titleCase)
              .join(', ')}
          </p>
          <p className="mt-1 truncate text-xs text-(--sea-ink-soft)">
            {titleCase(row.route)}
          </p>
        </div>
        <div className="shrink-0">
          <RatingIcon rating={row.typeRating} />
        </div>
      </div>
    </Link>
  );
}
