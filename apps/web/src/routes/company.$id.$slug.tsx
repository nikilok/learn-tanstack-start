import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  stripSearchParams,
  useNavigate,
} from '@tanstack/react-router';
import { ExternalLink, MapPin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { companyProfileQueryOptions } from '../api/companiesHouse';
import { geocodeQueryOptions } from '../api/geocode';
import { getHmrcBySlug, hmrcBySlugIdQueryOptions } from '../api/hmrc';
import { AddressMap } from '../components/AddressMap';
import { StatusBadge } from '../components/StatusBadge';
import { formatAddress, formatDate, titleCase } from '../utils';
import { buildCanonical } from '../utils/canonical';

export const Route = createFileRoute('/company/$id/$slug')({
  validateSearch: (search: Record<string, unknown>) => ({
    search: ((search.search as string) || '').trim(),
  }),
  search: {
    middlewares: [stripSearchParams({ search: '' })],
  },
  loader: async ({ params, context: { queryClient } }) => {
    const sponsor = await queryClient.ensureQueryData(
      hmrcBySlugIdQueryOptions(params.id),
    );

    if (!sponsor) {
      const matches = await getHmrcBySlug({ data: { slug: params.slug } });
      if (matches.length === 1) {
        throw redirect({
          to: '/company/$id/$slug',
          params: { id: matches[0].slugId, slug: params.slug },
          search: (prev) => ({ search: prev.search ?? '' }),
          statusCode: 301,
        });
      }
      if (matches.length > 1) {
        throw redirect({
          to: '/',
          search: { search: matches[0].organisationName },
          statusCode: 302,
        });
      }
      throw notFound();
    }

    const profile = await queryClient.ensureQueryData(
      companyProfileQueryOptions(sponsor.organisationName),
    );

    const address = profile?.registered_office_address
      ? formatAddress(profile.registered_office_address)
      : '';
    const geo = address
      ? await queryClient.ensureQueryData(geocodeQueryOptions(address))
      : null;

    return { sponsor, profile, geo };
  },
  head: ({ match }) => {
    const loaderData = match.loaderData as
      | {
          sponsor: {
            organisationName: string;
            townCity?: string | null;
            county?: string | null;
            route: string;
          };
          profile?: {
            sicDescriptions?: { code: string; description: string }[];
          } | null;
        }
      | undefined;

    const name = loaderData
      ? titleCase(loaderData.sponsor.organisationName)
      : 'Company Details';
    const location = loaderData
      ? [loaderData.sponsor.townCity ?? null, loaderData.sponsor.county ?? null]
          .filter(Boolean)
          .map(titleCase)
          .join(', ')
      : '';
    const industry = loaderData?.profile?.sicDescriptions
      ?.map((sic) => sic.description)
      .join(', ');
    const route = titleCase(loaderData?.sponsor.route ?? 'Skilled Worker');
    const description = [
      industry ? `${name} — ${industry}` : name,
      location
        ? `Licensed UK ${route} visa sponsor in ${location}`
        : `Licensed UK ${route} visa sponsor`,
    ].join('. ');

    const pageTitle = `${name} - UK Visa Sponsor | SponsorSearch`;
    const pageDescription = `${description}.`;

    return {
      meta: [
        { title: pageTitle },
        { name: 'description', content: pageDescription },
        { property: 'og:title', content: pageTitle },
        { property: 'og:description', content: pageDescription },
        { name: 'twitter:title', content: pageTitle },
        { name: 'twitter:description', content: pageDescription },
      ],
      links: [
        {
          rel: 'canonical',
          href: buildCanonical(match.pathname),
        },
      ],
    };
  },
  component: CompanyDetail,
});

/**
 * Company detail page combining the HMRC sponsor row (location, visa route,
 * rating) with the Companies House profile (status, incorporation date,
 * registered address, SIC descriptions) loaded by the route's `loader`.
 * Preserves the `search` param so the back-link returns to the same query.
 */
function CompanyDetail() {
  const { sponsor, profile, geo } = Route.useLoaderData();
  const { search } = Route.useSearch();
  const navigate = useNavigate();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      navigate({
        to: '/',
        search: { search },
        viewTransition: { types: ['back'] },
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, search]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) =>
      setStuck(!entry.isIntersecting),
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <div className="page-flip-details">
          <div className="rounded-lg bg-(--sponsor-card-bg) shadow-(--shadow-card) p-6">
            <h1 className="text-xl font-semibold text-(--sea-ink)">
              {titleCase(sponsor.organisationName)}
            </h1>
            {profile?.sicDescriptions && profile.sicDescriptions.length > 0 && (
              <p className="mt-1 text-sm text-(--sea-ink-soft)">
                {profile.sicDescriptions
                  .map((sic) => sic.description)
                  .join(', ')}
              </p>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                  Location
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {[sponsor.townCity, sponsor.county]
                    .filter(Boolean)
                    .map(titleCase)
                    .join(', ') || 'Not specified'}
                </dd>
              </div>
              {profile?.company_status && (
                <div>
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                    Status
                  </dt>
                  <dd className="mt-1">
                    <StatusBadge status={profile.company_status} />
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                  Visa Route
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {titleCase(sponsor.route)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                  Rating
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {titleCase(sponsor.typeRating)}
                </dd>
              </div>
            </dl>
          </div>

          {profile && (
            <div className="glass mt-4 rounded-lg p-6">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {formatDate(profile.date_of_creation) && (
                  <div>
                    <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                      Incorporated
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      {formatDate(profile.date_of_creation)}
                    </dd>
                  </div>
                )}

                {profile.type && (
                  <div>
                    <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                      Company Type
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      {titleCase(profile.type.replace(/-/g, ' '))}
                    </dd>
                  </div>
                )}

                {profile.accounts?.last_accounts?.made_up_to && (
                  <div>
                    <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                      Last Accounts Filed
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      {formatDate(profile.accounts.last_accounts.made_up_to)}
                    </dd>
                  </div>
                )}

                {profile.company_number && (
                  <div>
                    <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                      Registration No.
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      <span x-apple-data-detectors="false">
                        {profile.company_number}
                      </span>
                    </dd>
                  </div>
                )}

                {formatAddress(profile.registered_office_address) && (
                  <div className="col-span-2 sm:col-span-4">
                    <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                      Registered Address
                    </dt>
                    <dd className="mt-1 text-sm">
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(profile.registered_office_address))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="no-underline inline-flex items-center gap-1.5 text-(--sea-ink-soft) hover:text-(--sea-ink)"
                      >
                        <MapPin size={14} className="shrink-0" />
                        {formatAddress(profile.registered_office_address)}
                        <ExternalLink size={12} className="shrink-0" />
                      </a>
                      {geo && (
                        <div className="-mx-6 -mb-6 mt-3 overflow-hidden rounded-b-lg">
                          <AddressMap geo={geo} />
                        </div>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>

        <Link
          to="/"
          search={{ search }}
          viewTransition={{ types: ['back'] }}
          className={`no-underline sticky bottom-6 z-10 mt-6 text-sm font-medium text-(--sea-ink-soft) transition hover:text-(--sea-ink) ${
            stuck
              ? 'glass backdrop-blur-md! mx-auto flex w-fit items-center rounded-full px-5 py-2.5'
              : 'block w-full px-4 py-3 text-center'
          }`}
        >
          &larr; Back to search
          <kbd className="ml-2 hidden pointer-fine:inline font-sans text-xs">
            Esc
          </kbd>
        </Link>
        <div ref={sentinelRef} aria-hidden className="h-px w-px" />
      </section>
    </main>
  );
}
