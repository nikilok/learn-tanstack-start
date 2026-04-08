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
      className="block no-underline py-2"
      onClick={() =>
        sessionStorage.setItem('hmrc-scroll-y', String(window.scrollY))
      }
    >
      <h3 className="heading-card text-base font-semibold text-(--sea-ink)">
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
