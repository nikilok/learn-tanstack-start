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
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setSsrCacheControl,
  setCacheTag,
} from '../api/cache-headers';
import { companyProfileQueryOptions } from '../api/companiesHouse';
import { companyTimelineQueryOptions } from '../api/companyTimeline';
import { hmrcCompanyBySlugQueryOptions } from '../api/hmrc';
import { AddressMap } from '../components/AddressMap';
import BingLogo from '../components/BingLogo';
import { CompanyTimeline } from '../components/CompanyTimeline';
import { DetailField, LABEL_CLASS } from '../components/DetailField';
import DuckDuckGoLogo from '../components/DuckDuckGoLogo';
import GoogleLogo from '../components/GoogleLogo';
import GovUkLogo from '../components/GovUkLogo';
import LinkedInLogo from '../components/LinkedInLogo';
import { SeeMoreLink } from '../components/SeeMoreLink';
import { StatusBadge } from '../components/StatusBadge';
import { searchTermInput } from '../lib/search/params';
import {
  companySearchName,
  formatAddress,
  formatDate,
  formatLocation,
  humanizeEnum,
  normalizeName,
  skilledWorkerFirst,
  stampPageFlip,
  titleCase,
} from '../utils';
import { buildCanonical } from '../utils/canonical';
import { buildCompanyJsonLd, ratingPhrase } from '../utils/jsonld';
import { buildSeoHead } from '../utils/seo';

// Grammatical "A, B and C" joiner for the routes and former-names sentences.
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

/**
 * Former Companies House names for a company, with the current name, blanks, and
 * normalised duplicates (LTD/LIMITED, repeats) removed. Single source for both
 * the visible "previously known as" summary and the alternateName structured
 * data, so on-page content and JSON-LD can never diverge.
 */
function formerCompanyNames(
  previousNames: string[] | undefined,
  currentName: string,
): string[] {
  const seen = new Set([normalizeName(currentName)]);
  const out: string[] = [];
  for (const raw of previousNames ?? []) {
    const key = normalizeName(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Distinct visa routes of a company's licence rows, in shared display priority order. */
function distinctRoutes(licences: { route: string }[]): string[] {
  return skilledWorkerFirst([...new Set(licences.map((l) => l.route))]);
}

/** Distinct licence ratings of a company's licence rows, in stable order. */
function distinctRatings(licences: { typeRating: string }[]): string[] {
  return [...new Set(licences.map((l) => l.typeRating))].sort();
}

// The loader-data slice head() and the component both derive from — the ONE
// hand-written copy of this shape (head casts match.loaderData to it).
type CompanyDisplayInput = {
  sponsor: {
    licences: { organisationName: string; typeRating: string; route: string }[];
  };
  profile?: {
    company_name?: string;
    previousNames?: string[];
    company_number?: string;
    date_of_creation?: string;
    registered_office_address?: {
      address_line_1?: string;
      address_line_2?: string;
      locality?: string;
      region?: string;
      postal_code?: string;
      country?: string;
    } | null;
    sicDescriptions?: { code: string; description: string }[];
  } | null;
};

/** Shared head()/component derivations — one source, so page copy, meta description, and JSON-LD can never drift. */
function deriveCompanyDisplay({ sponsor, profile }: CompanyDisplayInput) {
  // licences[0] is the primary org by construction (rows arrive primary-first).
  const primaryOrg = sponsor.licences[0]?.organisationName ?? '';
  const rawName = profile?.company_name ?? primaryOrg;
  const currentKey = normalizeName(rawName);
  // Set AFTER titleCase: case-variant HMRC rows of the same alias must not
  // render twice ("…as Acme Support Ltd and Acme Support Ltd").
  const registeredNames = [
    ...new Set(sponsor.licences.map((l) => titleCase(l.organisationName))),
  ].filter((alias) => normalizeName(alias) !== currentKey);
  const routes = distinctRoutes(sponsor.licences);
  const ratings = distinctRatings(sponsor.licences);
  return {
    primaryOrg,
    name: titleCase(rawName),
    registeredNames,
    registeredAs: registeredNames.length
      ? listFormatter.format(registeredNames)
      : '',
    routes,
    routesText: listFormatter.format(routes.map(titleCase)),
    ratings,
    ratingText: ratingPhrase(ratings),
    location: registeredLocation(profile?.registered_office_address),
    industry: profile?.sicDescriptions
      ?.map((sic) => sic.description)
      .join(', '),
  };
}

export const Route = createFileRoute('/company/$slug')({
  // searchTermInput: the router JSON-parses ?search=365 into a NUMBER — a raw
  // string cast + .trim() throws on URLs the app itself mints.
  validateSearch: (search: Record<string, unknown>) => ({
    search: searchTermInput(search.search),
  }),
  search: {
    middlewares: [stripSearchParams({ search: '' })],
  },
  loader: async ({ params, location, context: { queryClient } }) => {
    const options = hmrcCompanyBySlugQueryOptions(params.slug);
    let company = await queryClient.ensureQueryData(options);
    // ensureQueryData never refetches cached non-undefined data, so a
    // session-cached miss (null/'moved') must be re-resolved explicitly — an
    // ingest can reinstate or re-rename the slug mid-session. fetchQuery
    // honours the staleTime fn: non-found results are always stale.
    if (!import.meta.env.SSR && (!company || company.kind !== 'found')) {
      company = await queryClient.fetchQuery(options);
    }

    if (!company) {
      // Best effort: keep the 404 document short-lived at the edge (a
      // reinstated sponsor can revive the URL). The static /company/**
      // routeRule header may still win at the edge — the post-ingest deploy
      // purge bounds the damage either way.
      setSsrCacheControl(SHORT_EDGE_CACHE);
      throw notFound();
    }

    // One canonical 301 for rename-moved slugs and slug variants alike.
    // SHORT-cached via the redirect's own headers (setSsrCacheControl does
    // not survive onto thrown redirects): slug→slug redirects can invert on
    // a rename flip-flop, and the /company/** routeRule's 30-day s-maxage
    // would otherwise pin one side of the loop at the edge. Static search
    // value — SSR redirects must not use a functional `search`.
    const redirectToCanonical = (slug: string) =>
      redirect({
        to: '/company/$slug',
        params: { slug },
        search: {
          search: (location.search as { search?: string }).search ?? '',
        },
        statusCode: 301,
        headers: { 'Cache-Control': SHORT_EDGE_CACHE },
      });

    if (company.kind === 'moved') {
      // SSR only: client navs read RQ/edge caches that can be stale after a
      // rename revert — redirecting on them can ping-pong two slugs. A full
      // load resolves the 301 server-side; the rare client hit just 404s.
      if (import.meta.env.SSR) throw redirectToCanonical(company.nameSlug);
      throw notFound();
    }

    // Canonicalise slug variants (SSR only): the fn slug-normalises its input,
    // so /company/Acme-Ltd resolves — but must 301, never serve 200 there.
    if (import.meta.env.SSR && company.nameSlug !== params.slug) {
      throw redirectToCanonical(company.nameSlug);
    }

    const profile = await queryClient.ensureQueryData(
      companyProfileQueryOptions(company.licences[0].organisationName),
    );

    // Timeline is auxiliary — a transient failure must not take down the page.
    const timeline = profile?.company_number
      ? await queryClient
          .ensureQueryData({
            ...companyTimelineQueryOptions(profile.company_number),
            revalidateIfStale: true,
          })
          .catch((error) => {
            console.error('[Timeline] load failed:', error);
            return null;
          })
      : null;

    // Edge-cache the SSR document — the /company/** routeRule loses to TanStack's private,no-store default, so set it explicitly (same reason the RPC does at companiesHouse.ts).
    // Short-cache when the timeline is missing for a company that should have
    // one (RPC error, or a first visit racing getCompanyProfile's background
    // upsert) so the degraded document isn't baked in for 30 days.
    const timelineMissing = Boolean(profile?.company_number) && !timeline;
    setSsrCacheControl(timelineMissing ? SHORT_EDGE_CACHE : LONG_EDGE_CACHE);
    // Tag the HTML with the same company-{number} tag as the RPC so the revalidate pipeline purges both.
    if (profile?.company_number) {
      setCacheTag(`company-${profile.company_number}`);
    }

    return { sponsor: company, profile, timeline };
  },
  head: ({ match }) => {
    // Same shape the loader returns; CompanyDisplayInput is the one written copy.
    const loaderData = match.loaderData as CompanyDisplayInput | undefined;

    // Lead with the Companies House current name; HMRC may hold a stale former name.
    const display = loaderData ? deriveCompanyDisplay(loaderData) : null;
    const name = display?.name ?? 'Company Details';
    const registeredNames = display?.registeredNames ?? [];
    const registeredAs = display?.registeredAs ?? '';
    const location = display?.location ?? '';
    const industry = display?.industry;
    const routesText = display?.routes.length
      ? display.routesText
      : 'Skilled Worker';
    const description = [
      industry ? `${name} — ${industry}` : name,
      location
        ? `Licensed UK ${routesText} visa sponsor in ${location}`
        : `Licensed UK ${routesText} visa sponsor`,
      registeredAs ? `Also registered as ${registeredAs}` : '',
    ]
      .filter(Boolean)
      .join('. ');

    const pageTitle = `${name} - UK Visa Sponsor | SponsorSearch`;
    const pageDescription = `${description}.`;
    const canonicalUrl = buildCanonical(match.pathname);

    // schema.org alternateName = every alias the page shows — the visible
    // "previously known as" names (same formerCompanyNames source as the About
    // summary) plus the HMRC "also registered as" names — so the structured
    // data mirrors the on-page copy. Exact-dedup only, NOT normalised: when the
    // HMRC and CH forms differ ("Acme Ltd" vs "Acme Limited") the page shows
    // both, so both belong here; normalising would drop one the copy renders.
    const priorNames =
      loaderData && display
        ? formerCompanyNames(
            loaderData.profile?.previousNames,
            loaderData.profile?.company_name ?? display.primaryOrg,
          ).map(titleCase)
        : [];
    const alternateName = [...registeredNames, ...priorNames].filter(
      (alt, i, all) => all.indexOf(alt) === i,
    );

    const jsonLd =
      loaderData && display
        ? buildCompanyJsonLd({
            name,
            legalName: loaderData.profile?.company_name ?? display.primaryOrg,
            alternateName,
            route: routesText,
            typeRating: display.ratings,
            location,
            industry,
            companyNumber: loaderData.profile?.company_number,
            dateOfCreation: loaderData.profile?.date_of_creation,
            address: loaderData.profile?.registered_office_address,
            canonicalUrl,
            homeUrl: buildCanonical('/'),
          })
        : [];

    return buildSeoHead({
      title: pageTitle,
      description: pageDescription,
      canonicalUrl,
      jsonLd,
    });
  },
  component: CompanyDetail,
});

/**
 * Company detail page combining every HMRC licence row for the slug (visa
 * routes, ratings) with the Companies House profile (status, incorporation
 * date, registered address, SIC descriptions) loaded by the route's `loader`.
 * Preserves the `search` param so the back-link returns to the same query.
 */
function CompanyDetail() {
  const { sponsor, profile, timeline } = Route.useLoaderData();
  const { search } = Route.useSearch();
  const navigate = useNavigate();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      stampPageFlip('back');
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

  // Shared derivations — the same values head() feeds the meta/JSON-LD from.
  const display = deriveCompanyDisplay({ sponsor, profile });
  const { name: displayName, routes, routesText, ratings } = display;
  // Noise-stripped query so external searches land on the right company.
  const searchQuery = encodeURIComponent(companySearchName(displayName));
  const alsoRegisteredAs = display.registeredAs || null;
  const ratingsText = ratings.map(titleCase).join(', ');
  // Every distinct licence number — a company can hold one per licence row
  // (105 slugs do); all render, stacked when several.
  const licenceNumbers = [
    ...new Set(
      sponsor.licences
        .map((l) => l.sponsorLicenceNumber)
        .filter((n): n is string => Boolean(n)),
    ),
  ];
  const displayLocation = display.location;
  const industry = display.industry;
  // Former names from Companies House, deduped against the current name;
  // title-cased at the display layer (the summary sentence).
  const formerNames = formerCompanyNames(
    profile?.previousNames,
    profile?.company_name ?? display.primaryOrg,
  );
  const incorporated = formatDate(profile?.date_of_creation);
  const rating = display.ratingText;
  // Shared by both card slots (no-profile card and the CH profile card).
  const licenceNumberField = licenceNumbers.length > 0 && (
    <DetailField
      label={
        licenceNumbers.length > 1
          ? 'Sponsor Licence Nos.'
          : 'Sponsor Licence No.'
      }
      literal
      value={
        licenceNumbers.length > 1 ? (
          <span className="flex flex-col gap-0.5">
            {licenceNumbers.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </span>
        ) : (
          licenceNumbers[0]
        )
      }
    />
  );
  const intro = `${displayName} is a licensed UK ${routesText} visa sponsor${displayLocation ? ` based in ${displayLocation}` : ''}, holding ${rating} sponsor status on the UK Home Office register.`;
  let background = '';
  if (incorporated && industry) {
    background = `The company was incorporated on ${incorporated} and operates in ${industry}.`;
  } else if (incorporated) {
    background = `The company was incorporated on ${incorporated}.`;
  } else if (industry) {
    background = `The company operates in ${industry}.`;
  }
  const outro = `${displayName} can sponsor international workers for the UK ${routesText} ${routes.length > 1 ? 'visa routes' : 'visa'} under its current Home Office licence.`;
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
            <h1 className="text-xl font-semibold text-(--sea-ink)">
              {displayName}
            </h1>
            <p className="mt-1 text-sm text-(--sea-ink)">
              {routes.length > 2
                ? `Licensed UK visa sponsor across ${routes.length} routes`
                : `Licensed UK ${routesText} visa sponsor`}
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
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <DetailField
                label="Location"
                value={displayLocation || 'Not specified'}
              />
              {profile?.company_status && (
                <DetailField
                  label="Status"
                  value={<StatusBadge status={profile.company_status} />}
                  valueClassName="mt-1"
                />
              )}
              {routes.length === 1 ? (
                <DetailField label="Visa Route" value={titleCase(routes[0])} />
              ) : (
                <DetailField
                  label="Visa Routes"
                  // Badges stack vertically in a normal grid cell (Ratings
                  // stays alongside); long route names wrap inside the badge.
                  valueClassName="mt-1.5"
                  value={
                    <span className="flex flex-col items-start gap-1.5">
                      {routes.map((route) => (
                        <span
                          key={route}
                          className="rounded-md bg-(--chip-bg) px-2 py-0.5 font-mono text-xs text-(--sea-ink-soft) ring-1 ring-(--chip-line) ring-inset"
                        >
                          {titleCase(route)}
                        </span>
                      ))}
                    </span>
                  }
                />
              )}
              <DetailField
                label={ratings.length > 1 ? 'Ratings' : 'Rating'}
                valueClassName={ratings.length > 1 ? 'mt-1.5' : undefined}
                value={
                  ratings.length > 1 ? (
                    // Badge stack matching the Visa Routes pills, so multiple
                    // ratings read as separate licences at a glance.
                    <span className="flex flex-col items-start gap-1.5">
                      {ratings.map((r) => (
                        <span
                          key={r}
                          className="rounded-md bg-(--chip-bg) px-2 py-0.5 font-mono text-xs text-(--sea-ink-soft) ring-1 ring-(--chip-line) ring-inset"
                        >
                          {titleCase(r)}
                        </span>
                      ))}
                    </span>
                  ) : (
                    ratingsText
                  )
                }
              />
              {/* No CH mapping → no second section, so surface the licence here instead. */}
              {!profile && licenceNumberField}
            </dl>
          </div>

          {profile && (
            <div className="glass mt-4 rounded-lg p-6">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {formatDate(profile.date_of_creation) && (
                  <DetailField
                    label="Incorporated"
                    value={formatDate(profile.date_of_creation)}
                  />
                )}

                {profile.type && (
                  <DetailField
                    label="Company Type"
                    value={humanizeEnum(profile.type)}
                  />
                )}

                {profile.accounts?.last_accounts?.made_up_to && (
                  <DetailField
                    label="Last Accounts Filed"
                    value={formatDate(
                      profile.accounts.last_accounts.made_up_to,
                    )}
                  />
                )}

                {profile.company_number && (
                  <DetailField
                    label="Registration No."
                    value={profile.company_number}
                    literal
                  />
                )}

                {licenceNumberField}

                {formatAddress(profile.registered_office_address) && (
                  <DetailField
                    label="Registered Address"
                    className="col-span-2 sm:col-span-4"
                    valueClassName="mt-1 text-sm"
                    value={
                      <>
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
                      </>
                    }
                  />
                )}
              </dl>
            </div>
          )}
        </div>

        <section className="mt-6" aria-labelledby="sponsor-about-heading">
          <h2 id="sponsor-about-heading" className={LABEL_CLASS}>
            About
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-(--sea-ink-soft)">
            {summary}
          </p>
        </section>

        {timeline && (
          <section className="mt-6" aria-labelledby="company-timeline-heading">
            <h2 id="company-timeline-heading" className={LABEL_CLASS}>
              Timeline
            </h2>
            <CompanyTimeline events={timeline.events} />
          </section>
        )}

        <section className="mt-6" aria-labelledby="see-more-heading">
          <h2 id="see-more-heading" className={`mb-2 ${LABEL_CLASS}`}>
            See more on
          </h2>
          <div className="flex flex-wrap gap-4 sm:gap-x-2">
            {/* GOV.UK needs the Companies House record; the search engines query by name. */}
            {profile?.company_number && (
              <SeeMoreLink
                href={`https://find-and-update.company-information.service.gov.uk/company/${profile.company_number}`}
                logo={<GovUkLogo className="h-5 w-auto" />}
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
        </section>

        <Link
          to="/"
          search={{ search }}
          viewTransition={{ types: ['back'] }}
          onClick={() => stampPageFlip('back')}
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
