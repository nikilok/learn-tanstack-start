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

import {
  SHORT_EDGE_CACHE,
  setSsrCacheControl,
} from '../api/cache-headers';
import { companyProfileQueryOptions } from '../api/companiesHouse';
import { flagStateQueryOptions } from '../api/flags';
import { getHmrcBySlug, hmrcBySlugIdQueryOptions } from '../api/hmrc';
import { AddressMap } from '../components/AddressMap';
import BingLogo from '../components/BingLogo';
import DuckDuckGoLogo from '../components/DuckDuckGoLogo';
import GoogleLogo from '../components/GoogleLogo';
import GovUkLogo from '../components/GovUkLogo';
import LinkedInLogo from '../components/LinkedInLogo';
import { NameHistory } from '../components/NameHistory';
import { SeeMoreLink } from '../components/SeeMoreLink';
import { StatusBadge } from '../components/StatusBadge';
import {
  companySearchName,
  formatAddress,
  formatDate,
  formatLocation,
  titleCase,
} from '../utils';
import { buildCanonical } from '../utils/canonical';
import { buildCompanyJsonLd, ratingPhrase } from '../utils/jsonld';

// Grammatical "A, B and C" joiner for the former-names sentence in the summary.
const listFormatter = new Intl.ListFormat('en-GB', { type: 'conjunction' });

/**
 * Display location for a CH registered-office address. Mirrors searchHmrc's
 * COALESCE(locality, address_line_2) + region so the detail page agrees with
 * the listing card on whether a sponsor has a location.
 */
function registeredLocation(
  address?: {
    address_line_2?: string;
    locality?: string;
    region?: string;
  } | null,
) {
  return formatLocation(
    address?.locality ?? address?.address_line_2,
    address?.region,
  );
}

// Canonical key for company-name equality (case, punctuation, LTD/LIMITED).
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,]/g, '')
    .replace(/\bLIMITED\b/g, 'LTD')
    .replace(/\s+/g, ' ')
    .trim();
}

export const Route = createFileRoute('/company/$id/$slug')({
  validateSearch: (search: Record<string, unknown>) => ({
    search: ((search.search as string) || '').trim(),
  }),
  search: {
    middlewares: [stripSearchParams({ search: '' })],
  },
  loader: async ({ params, context: { queryClient } }) => {
    let sponsor = await queryClient.ensureQueryData(
      hmrcBySlugIdQueryOptions(params.id),
    );

    if (!sponsor) {
      const matches = await getHmrcBySlug({ data: { slug: params.slug } });
      if (matches.some((m) => m.slugId === params.id)) {
        // The (uncached) slug lookup sees this very hash, so the cached null
        // is stale — licence reinstated under the same hash by a later
        // ingest. Drop the entry and refetch: invalidateQueries never
        // refetches an observer-less query, and ensureQueryData would just
        // return the cached null again.
        queryClient.removeQueries({
          queryKey: hmrcBySlugIdQueryOptions(params.id).queryKey,
        });
        sponsor = await queryClient.ensureQueryData(
          hmrcBySlugIdQueryOptions(params.id),
        );
      } else if (matches.length > 0) {
        // 301 to the slug's canonical (hash-ordered first) row so stale
        // URLs land on a real page and keep link equity. Safe on client
        // navs too: getHmrcBySlug reads the DB uncached.
        throw redirect({
          to: '/company/$id/$slug',
          params: { id: matches[0].slugId, slug: params.slug },
          search: (prev) => ({ search: prev.search ?? '' }),
          statusCode: 301,
        });
      }
      if (!sponsor) {
        // Best effort: keep the 404 document short-lived at the edge (a
        // reinstated licence can revive the URL). The static /company/**
        // routeRule header may still win at the edge — verify on deploy;
        // the post-ingest deploy purge bounds the damage either way.
        setSsrCacheControl(SHORT_EDGE_CACHE);
        throw notFound();
      }
    }

    // Canonicalize on SSR only. Server loaders read the DB in-process, so the
    // redirect decision is always fresh; client navs read RQ/edge caches whose
    // canonicalSlugId/nameSlug can be stale (rename, removed sibling) — acting
    // on those loops redirects or bounces correct URLs onto stale slugs.
    // Crawlers only ever see SSR, so the SEO-relevant 301s are unaffected;
    // client navs simply render under the URL they were given.
    // Truthiness guards: a cached pre-deploy row may predate these fields, and
    // `undefined !== params.id` would 301 to /company/undefined/undefined.
    if (
      import.meta.env.SSR &&
      ((sponsor.canonicalSlugId && sponsor.canonicalSlugId !== params.id) ||
        (sponsor.nameSlug && sponsor.nameSlug !== params.slug))
    ) {
      // One canonical URL per page: sibling licence hashes 301 onto the
      // group's min-hash row, and stale slugs (post-rename) onto the current
      // slug — otherwise near-duplicate 200s accumulate in the index.
      throw redirect({
        to: '/company/$id/$slug',
        params: {
          id: sponsor.canonicalSlugId || params.id,
          slug: sponsor.nameSlug || params.slug,
        },
        search: (prev) => ({ search: prev.search ?? '' }),
        statusCode: 301,
      });
    }

    const profile = await queryClient.ensureQueryData(
      companyProfileQueryOptions(sponsor.organisationName),
    );

    const flagState = await queryClient.ensureQueryData(flagStateQueryOptions);

    return { sponsor, profile, flagState };
  },
  head: ({ match }) => {
    const loaderData = match.loaderData as
      | {
          sponsor: {
            organisationName: string;
            typeRating: string;
            route: string;
          };
          profile?: {
            company_name?: string;
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

    // Lead with the Companies House current name; HMRC may hold a stale former name.
    const name = loaderData
      ? titleCase(
          loaderData.profile?.company_name ??
            loaderData.sponsor.organisationName,
        )
      : 'Company Details';
    const registeredAs =
      loaderData &&
      normalizeName(loaderData.sponsor.organisationName) !== normalizeName(name)
        ? titleCase(loaderData.sponsor.organisationName)
        : '';
    const location = loaderData
      ? registeredLocation(loaderData.profile?.registered_office_address)
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
      registeredAs ? `Also registered as ${registeredAs}` : '',
    ]
      .filter(Boolean)
      .join('. ');

    const pageTitle = `${name} - UK Visa Sponsor | SponsorSearch`;
    const pageDescription = `${description}.`;
    const canonicalUrl = buildCanonical(match.pathname);

    const jsonLd = loaderData
      ? buildCompanyJsonLd({
          name,
          legalName:
            loaderData.profile?.company_name ??
            loaderData.sponsor.organisationName,
          alternateName: registeredAs || undefined,
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
  const { sponsor, profile, flagState } = Route.useLoaderData();
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

  // Router match-cache can replay loaderData from an older bundle (SWR render
  // on revisit); tolerate the field's absence instead of crashing on .length
  const licenceNumbers = sponsor.sponsorLicenceNumbers ?? [];
  const hmrcName = titleCase(sponsor.organisationName);
  // Lead with the Companies House current name; HMRC may hold a stale former name.
  const displayName = profile?.company_name
    ? titleCase(profile.company_name)
    : hmrcName;
  // Noise-stripped query so external searches land on the right company.
  const searchQuery = encodeURIComponent(companySearchName(displayName));
  const currentKey = normalizeName(
    profile?.company_name ?? sponsor.organisationName,
  );
  const alsoRegisteredAs =
    normalizeName(sponsor.organisationName) !== currentKey ? hmrcName : null;
  const displayRoute = titleCase(sponsor.route);
  const displayLocation = registeredLocation(
    profile?.registered_office_address,
  );
  const industry = profile?.sicDescriptions
    ?.map((s) => s.description)
    .join(', ');
  // Former names from Companies House: drop the current name and blanks, and
  // dedupe (normalised) so LTD/LIMITED and repeat entries collapse. Title-casing
  // happens at the display layer (NameHistory / the summary sentence).
  const seenNames = new Set([currentKey]);
  const formerNames: string[] = [];
  for (const raw of profile?.previousNames ?? []) {
    const key = normalizeName(raw);
    if (!key || seenNames.has(key)) continue;
    seenNames.add(key);
    formerNames.push(raw);
  }
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
  const registered = alsoRegisteredAs
    ? `It appears on the UK Home Office sponsor register as ${alsoRegisteredAs}.`
    : '';
  const history = formerNames.length
    ? `It was previously known as ${listFormatter.format(formerNames.map(titleCase))}.`
    : '';
  const summary = [intro, registered, background, history, outro]
    .filter(Boolean)
    .join(' ');

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <div className="page-flip-details">
          <div className="rounded-lg bg-(--sponsor-card-bg) p-6 shadow-(--shadow-card)">
            <NameHistory currentName={displayName} previousNames={formerNames}>
              <p className="mt-1 text-sm text-(--sea-ink)">
                Licensed UK {displayRoute} visa sponsor
                {displayLocation ? ` in ${displayLocation}` : ''}
              </p>
              {alsoRegisteredAs && (
                <p className="mt-1 text-sm text-(--sea-ink-soft)">
                  Also registered with HMRC as {alsoRegisteredAs}
                </p>
              )}
              {industry && (
                <p className="mt-1 text-sm text-(--sea-ink-soft)">{industry}</p>
              )}
            </NameHistory>
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                  Location
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {displayLocation || 'Not specified'}
                </dd>
              </div>
              {profile?.company_status && (
                <div>
                  <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                    Status
                  </dt>
                  <dd className="mt-1">
                    <StatusBadge status={profile.company_status} />
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                  Visa Route
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {titleCase(sponsor.route)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                  Rating
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {titleCase(sponsor.typeRating)}
                </dd>
              </div>
              {/* No CH profile → the second card never renders; surface the licence here instead */}
              {!profile && licenceNumbers.length > 0 && (
                <div>
                  <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                    Sponsor Licence{' '}
                    {licenceNumbers.length > 1 ? 'Nos.' : 'No.'}
                  </dt>
                  <dd className="mt-1 text-sm text-(--sea-ink)">
                    <span x-apple-data-detectors="false">
                      {licenceNumbers.join(', ')}
                    </span>
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {profile && (
            <div className="glass mt-4 rounded-lg p-6">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {formatDate(profile.date_of_creation) && (
                  <div>
                    <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                      Incorporated
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      {formatDate(profile.date_of_creation)}
                    </dd>
                  </div>
                )}

                {profile.type && (
                  <div>
                    <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                      Company Type
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      {titleCase(profile.type.replace(/-/g, ' '))}
                    </dd>
                  </div>
                )}

                {profile.accounts?.last_accounts?.made_up_to && (
                  <div>
                    <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                      Last Accounts Filed
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      {formatDate(profile.accounts.last_accounts.made_up_to)}
                    </dd>
                  </div>
                )}

                {profile.company_number && (
                  <div>
                    <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                      Registration No.
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      <span x-apple-data-detectors="false">
                        {profile.company_number}
                      </span>
                    </dd>
                  </div>
                )}

                {licenceNumbers.length > 0 && (
                  <div>
                    <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                      Sponsor Licence{' '}
                      {licenceNumbers.length > 1 ? 'Nos.' : 'No.'}
                    </dt>
                    <dd className="mt-1 text-sm text-(--sea-ink)">
                      <span x-apple-data-detectors="false">
                        {licenceNumbers.join(', ')}
                      </span>
                    </dd>
                  </div>
                )}

                {formatAddress(profile.registered_office_address) && (
                  <div className="col-span-2 sm:col-span-4">
                    <dt className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
                      Registered Address
                    </dt>
                    <dd className="mt-1 text-sm">
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(profile.registered_office_address))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-(--sea-ink-soft) no-underline hover:text-(--sea-ink)"
                      >
                        <MapPin size={14} className="shrink-0" />
                        {formatAddress(profile.registered_office_address)}
                        <ExternalLink size={12} className="shrink-0" />
                      </a>
                      <div className="-mx-6 mt-3 -mb-6 overflow-hidden rounded-b-lg">
                        <AddressMap
                          address={formatAddress(
                            profile.registered_office_address,
                          )}
                          companyName={displayName}
                        />
                      </div>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>

        <section className="mt-6" aria-labelledby="sponsor-about-heading">
          <h2
            id="sponsor-about-heading"
            className="text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase"
          >
            About
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-(--sea-ink-soft)">
            {summary}
          </p>
          <div className="mt-4">
            <h3 className="mb-2 text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase">
              See more on
            </h3>
            <div className="flex flex-wrap gap-4 sm:gap-x-2">
              {/* GOV.UK needs the Companies House record; the search engines query by name. */}
              {profile?.company_number && (
                <SeeMoreLink
                  href={`https://find-and-update.company-information.service.gov.uk/company/${profile.company_number}`}
                  logo={
                    flagState.govukBranded ? (
                      <GovUkLogo className="h-5 w-auto" />
                    ) : undefined
                  }
                  label={flagState.govukBranded ? undefined : 'GOV.UK'}
                />
              )}
              <SeeMoreLink
                href={`https://www.google.com/search?q=${searchQuery}`}
                logo={<GoogleLogo className="brand-mark h-5 w-auto" />}
                label="Google"
                ariaLabel={`Search Google for ${displayName}`}
              />
              <SeeMoreLink
                href={`https://www.bing.com/search?q=${searchQuery}`}
                logo={<BingLogo className="brand-mark h-5 w-auto" />}
                label="Bing"
                ariaLabel={`Search Bing for ${displayName}`}
              />
              <SeeMoreLink
                href={`https://duckduckgo.com/?q=${searchQuery}`}
                logo={<DuckDuckGoLogo className="brand-mark h-5 w-auto" />}
                label="DuckDuckGo"
                ariaLabel={`Search DuckDuckGo for ${displayName}`}
              />
              <SeeMoreLink
                href={`https://www.linkedin.com/search/results/companies/?keywords=${searchQuery}`}
                logo={<LinkedInLogo className="brand-mark h-5 w-auto" />}
                label="LinkedIn"
                ariaLabel={`Search LinkedIn for ${displayName}`}
              />
            </div>
          </div>
        </section>

        <Link
          to="/"
          search={{ search }}
          viewTransition={{ types: ['back'] }}
          style={{ transition: 'none' }}
          className={`sticky bottom-6 z-10 mt-6 text-sm font-medium text-(--sea-ink-soft) no-underline hover:text-(--sea-ink) ${
            stuck
              ? 'glass mx-auto flex w-fit items-center rounded-full px-5 py-2.5 backdrop-blur-md!'
              : 'block w-full px-4 py-3 text-center'
          }`}
        >
          <span className={stuck ? 'shimmer-text' : undefined}>
            &larr; Back to search
          </span>
          <kbd className="ml-2 hidden font-sans text-xs pointer-fine:inline">
            Esc
          </kbd>
        </Link>
        <div ref={sentinelRef} aria-hidden className="h-px w-px" />
      </section>
    </main>
  );
}
