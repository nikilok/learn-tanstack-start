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
import { formatAddress, formatDate, formatLocation, titleCase } from '../utils';
import { buildCanonical } from '../utils/canonical';
import { buildCompanyJsonLd, ratingPhrase } from '../utils/jsonld';

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
            typeRating: string;
            route: string;
          };
          profile?: {
            company_number?: string;
            date_of_creation?: string;
            registered_office_address?: {
              address_line_1?: string;
              address_line_2?: string;
              locality?: string;
              region?: string;
              postal_code?: string;
              country?: string;
            };
            sicDescriptions?: { code: string; description: string }[];
          } | null;
        }
      | undefined;

    const name = loaderData
      ? titleCase(loaderData.sponsor.organisationName)
      : 'Company Details';
    const location = loaderData
      ? formatLocation(loaderData.sponsor.townCity, loaderData.sponsor.county)
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
    const canonicalUrl = buildCanonical(match.pathname);

    const jsonLd = loaderData
      ? buildCompanyJsonLd({
          name,
          legalName: loaderData.sponsor.organisationName,
          route,
          typeRating: loaderData.sponsor.typeRating,
          location,
          industry,
          companyNumber: loaderData.profile?.company_number,
          dateOfCreation: loaderData.profile?.date_of_creation,
          address: loaderData.profile?.registered_office_address,
          canonicalUrl,
          homeUrl: buildCanonical('/'),
        })
      : [];

    return {
      meta: [
        { title: pageTitle },
        { name: 'description', content: pageDescription },
        { property: 'og:title', content: pageTitle },
        { property: 'og:description', content: pageDescription },
        { property: 'og:url', content: canonicalUrl },
        { name: 'twitter:title', content: pageTitle },
        { name: 'twitter:description', content: pageDescription },
        { name: 'twitter:url', content: canonicalUrl },
        // 'script:ld+json' is supported at runtime but not exposed in the framework's meta types.
        ...jsonLd.map(
          (schema) =>
            ({ 'script:ld+json': schema }) as unknown as { name: string },
        ),
      ],
      links: [
        {
          rel: 'canonical',
          href: canonicalUrl,
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

  const displayName = titleCase(sponsor.organisationName);
  const displayRoute = titleCase(sponsor.route);
  const displayLocation = formatLocation(sponsor.townCity, sponsor.county);
  const industry = profile?.sicDescriptions
    ?.map((s) => s.description)
    .join(', ');
  const incorporated = formatDate(profile?.date_of_creation);
  const rating = ratingPhrase(sponsor.typeRating);
  const intro = `${displayName} is a licensed UK ${displayRoute} visa sponsor${displayLocation ? ` based in ${displayLocation}` : ''}, holding ${rating} sponsor status on the UK Home Office register.`;
  let background = '';
  if (incorporated && industry) {
    background = `The company was incorporated on ${incorporated} and operates in ${industry}.`;
  } else if (incorporated) {
    background = `The company was incorporated on ${incorporated}.`;
  } else if (industry) {
    background = `The company operates in ${industry}.`;
  }
  const outro = `${displayName} can sponsor international workers for the UK ${displayRoute} visa under its current Home Office licence.`;
  const summary = [intro, background, outro].filter(Boolean).join(' ');

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <div className="page-flip-details">
          <div className="rounded-lg bg-(--sponsor-card-bg) shadow-(--shadow-card) p-6">
            <h1 className="text-xl font-semibold text-(--sea-ink)">
              {displayName}
            </h1>
            <p className="mt-1 text-sm text-(--sea-ink)">
              Licensed UK {displayRoute} visa sponsor
              {displayLocation ? ` in ${displayLocation}` : ''}
            </p>
            {industry && (
              <p className="mt-1 text-sm text-(--sea-ink-soft)">{industry}</p>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                  Location
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {displayLocation || 'Not specified'}
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
                          <AddressMap
                            geo={geo}
                            companyName={titleCase(sponsor.organisationName)}
                          />
                        </div>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>

        <section className="mt-6" aria-labelledby="sponsor-about-heading">
          <h2 id="sponsor-about-heading" className="sr-only">
            About this sponsor
          </h2>
          <p className="text-sm leading-relaxed text-(--sea-ink-soft)">
            {summary}
          </p>
          {profile?.company_number && (
            <a
              href={`https://find-and-update.company-information.service.gov.uk/company/${profile.company_number}`}
              target="_blank"
              rel="noopener noreferrer"
              className="no-underline glass mt-4 inline-flex w-fit items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-[#0072f5] dark:text-[#3b9eff]"
            >
              View on Companies House
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </section>

        <Link
          to="/"
          search={{ search }}
          viewTransition={{ types: ['back'] }}
          style={{ transition: 'none' }}
          className={`no-underline sticky bottom-6 z-10 mt-6 text-sm font-medium text-(--sea-ink-soft) hover:text-(--sea-ink) ${
            stuck
              ? 'glass backdrop-blur-md! mx-auto flex w-fit items-center rounded-full px-5 py-2.5'
              : 'block w-full px-4 py-3 text-center'
          }`}
        >
          <span className={stuck ? 'shimmer-text' : undefined}>
            &larr; Back to search
          </span>
          <kbd className="ml-2 hidden pointer-fine:inline font-sans text-xs">
            Esc
          </kbd>
        </Link>
        <div ref={sentinelRef} aria-hidden className="h-px w-px" />
      </section>
    </main>
  );
}
