import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  stripSearchParams,
  useNavigate,
} from '@tanstack/react-router';
import { ExternalLink, Globe, MapPin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setSsrCacheControl,
  setCompanyCacheTag,
} from '../api/cache-headers';
import { companyProfileQueryOptions } from '../api/companiesHouse';
import { companyTimelineQueryOptions } from '../api/companyTimeline';
import {
  type CompanyWebsite,
  companyWebsiteQueryOptions,
} from '../api/companyWebsite';
import { hmrcCompanyBySlugQueryOptions } from '../api/hmrc';
import { AddressMap } from '../components/AddressMap';
import BingLogo from '../components/BingLogo';
import { CompanyIndustry } from '../components/CompanyIndustry';
import { CompanyTimeline } from '../components/CompanyTimeline';
import { DetailField, LABEL_CLASS } from '../components/DetailField';
import DuckDuckGoLogo from '../components/DuckDuckGoLogo';
import GoogleLogo from '../components/GoogleLogo';
import GovUkLogo from '../components/GovUkLogo';
import LinkedInLogo from '../components/LinkedInLogo';
import RatingIcon from '../components/RatingIcon';
import { SeeMoreLink } from '../components/SeeMoreLink';
import { StatusBadge } from '../components/StatusBadge';
import {
  type CompanyDisplayInput,
  deriveCompanyDisplay,
} from '../lib/company/display';
import { companyDocumentDegraded } from '../lib/company/document-cache';
import type { RouteLicence } from '../lib/company/licences';
import { displayDomain } from '../lib/company/website';
import { searchTermInput } from '../lib/search/params';
import {
  companySearchName,
  formatAddress,
  formatDate,
  humanizeEnum,
  stampPageFlip,
  titleCase,
} from '../utils';
import { buildCanonical } from '../utils/canonical';
import { buildCompanyJsonLd } from '../utils/jsonld';
import { buildSeoHead } from '../utils/seo';

// Grammatical "A, B and C" joiner for the routes and former-names sentences.
const listFormatter = new Intl.ListFormat('en-GB', { type: 'conjunction' });

/**
 * One enclosed row per licence: the visa route and the rating held on THAT
 * route. A real <dl> so the pairing is machine-readable — each route is the
 * term and its rating the definition, which crawlers, assistants and screen
 * readers all resolve. Presentationally the shared background carries the same
 * association for sighted users: rendered as free-floating siblings, a narrow
 * viewport wraps the rating onto its own line where it reads as belonging to
 * the next route, the same mis-pairing two parallel columns cause.
 */
function LicenceStack({ items }: { items: RouteLicence[] }) {
  return (
    <dl className="flex flex-col gap-1.5">
      {items.map(({ route, ratings }) => (
        <div
          key={route}
          className="flex flex-col gap-0.5 rounded-md bg-(--card-row-bg) px-2.5 py-1.5 ring-1 ring-(--card-row-line) ring-inset sm:flex-row sm:items-center sm:justify-between sm:gap-x-4"
        >
          <dt className="font-mono text-xs break-words text-(--sea-ink-soft)">
            {titleCase(route)}
          </dt>
          {/* Right-aligned on desktop so ratings form their own column: run
              inline against the route and the two read as one sentence. */}
          <dd className="flex shrink-0 flex-wrap items-center gap-x-3 sm:justify-end">
            {ratings.map((rating) => (
              <RatingIcon key={rating} rating={rating} />
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
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
    // SSR: per-request cache → ensure. Client: fetchQuery ALONE — via the
    // staleTime fn a cached 'found' returns with no fetch, while a cached
    // miss (null/'moved') is always stale and re-resolves in exactly one
    // fetch (ensureQueryData would return the cached miss without ever
    // refetching; ensure-then-fetch would double-fetch uncached misses).
    const company = import.meta.env.SSR
      ? await queryClient.ensureQueryData(options)
      : await queryClient.fetchQuery(options);

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

    // Both are auxiliary — a transient failure must not take down the page —
    // and both key off the same company number, so they run together rather
    // than stacking another round trip onto the load.
    // A failed website lookup has to stay distinguishable from a successful
    // "no website": both render the same page, but only the first must not be
    // cached for 30 days. See companyDocumentDegraded.
    const [timeline, websiteLoad] = profile?.company_number
      ? await Promise.all([
          queryClient
            .ensureQueryData({
              ...companyTimelineQueryOptions(profile.company_number),
              revalidateIfStale: true,
            })
            .catch((error) => {
              console.error('[Timeline] load failed:', error);
              return null;
            }),
          queryClient
            .ensureQueryData(companyWebsiteQueryOptions(profile.company_number))
            .then((website) => ({ website, failed: false }))
            .catch((error) => {
              console.error('[Website] load failed:', error);
              return { website: null, failed: true };
            }),
        ])
      : [null, { website: null, failed: false }];
    const website = websiteLoad.website;

    // Edge-cache the SSR document — the /company/** routeRule loses to TanStack's private,no-store default, so set it explicitly (same reason the RPC does at companiesHouse.ts).
    // Short-cache a document built from incomplete data (a timeline RPC error,
    // a first visit racing getCompanyProfile's background upsert, or a website
    // lookup that threw) so the degraded rendering isn't baked in for 30 days.
    const degraded = companyDocumentDegraded({
      hasCompanyNumber: Boolean(profile?.company_number),
      timelineLoaded: Boolean(timeline),
      websiteLookupFailed: websiteLoad.failed,
    });
    setSsrCacheControl(degraded ? SHORT_EDGE_CACHE : LONG_EDGE_CACHE);
    // Same tags as the RPCs, so both purge pipelines cover HTML and data alike.
    // Unmapped sponsors get the population tag alone — still nightly-purgeable.
    setCompanyCacheTag(profile?.company_number);

    return { sponsor: company, profile, timeline, website };
  },
  head: ({ match }) => {
    // Same shape the loader returns; CompanyDisplayInput is the one written
    // copy. The website is not part of the display derivation, so it rides
    // alongside rather than widening that type.
    const loaderData = match.loaderData as
      | (CompanyDisplayInput & { website?: CompanyWebsite | null })
      | undefined;

    // Lead with the Companies House current name; HMRC may hold a stale former name.
    const display = loaderData ? deriveCompanyDisplay(loaderData) : null;
    const name = display?.name ?? 'Company Details';
    const registeredNames = display?.registeredNames ?? [];
    const registeredAs = display?.registeredAs ?? '';
    const location = display?.location ?? '';
    const industry = display?.industry;
    const routes = display?.routes ?? [];
    // Same >2 collapse the visible H1 uses: spelling out six route names blows
    // past the SERP snippet limit and pushes the location out of the snippet.
    const sponsorPhrase =
      routes.length > 2
        ? `Licensed UK visa sponsor across ${routes.length} routes`
        : `Licensed UK ${display?.routesText || 'Skilled Worker'} visa sponsor`;
    const description = [
      industry ? `${name} — ${industry}` : name,
      location ? `${sponsorPhrase} in ${location}` : sponsorPhrase,
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
    const priorNames = display ? display.formerNames.map(titleCase) : [];
    const alternateName = [...registeredNames, ...priorNames].filter(
      (alt, i, all) => all.indexOf(alt) === i,
    );

    const jsonLd =
      loaderData && display
        ? buildCompanyJsonLd({
            name,
            legalName: display.rawName,
            alternateName,
            // Paired route→rating, not two flat lists: see CompanyJsonLdInput.
            licences: display.routeLicences.map((l) => ({
              route: titleCase(l.route),
              ratings: l.ratings,
            })),
            location,
            industry,
            companyNumber: loaderData.profile?.company_number,
            dateOfCreation: loaderData.profile?.date_of_creation,
            address: loaderData.profile?.registered_office_address,
            canonicalUrl,
            homeUrl: buildCanonical('/'),
            websiteUrl: loaderData.website?.url,
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
  const { sponsor, profile, timeline, website } = Route.useLoaderData();
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
  const {
    name: displayName,
    routes,
    routesText,
    ratings,
    routeLicences: licences,
  } = display;
  // Noise-stripped query so external searches land on the right company.
  const searchQuery = encodeURIComponent(companySearchName(displayName));
  const alsoRegisteredAs = display.registeredAs || null;
  const ratingsText = ratings.map(titleCase).join(', ');
  // Every distinct licence number — a company can hold one per licence row
  // (105 slugs do); all render, stacked when several. Sourced from the
  // identity-safe set so an unmapped namesake's number is never shown here.
  const licenceNumbers = [
    ...new Set(
      display.licences
        .map((l) => l.sponsorLicenceNumber)
        .filter((n): n is string => Boolean(n)),
    ),
  ];
  const displayLocation = display.location;
  const industry = display.industry;
  const sicEntries = display.sicEntries;
  // Former names from Companies House (derived once, shared with head()).
  const formerNames = display.formerNames;
  const incorporated = formatDate(profile?.date_of_creation);
  // When the ratings differ by route, the summary must say WHICH is which —
  // "A-rated and B-rated sponsor status" leaves a reader (or an LLM quoting
  // this page) to guess, and guessing by order is wrong half the time.
  const rating = display.licencesVary
    ? listFormatter.format(display.licencePhrases)
    : display.ratingText;
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
  // Mixed ratings need their own sentence — "holding B-rated for Skilled
  // Worker … sponsor status" is not a sentence, and cramming the pairs into
  // the clause is what made the aggregate phrasing tempting in the first place.
  const locationClause = displayLocation ? ` based in ${displayLocation}` : '';
  // ONE enumeration per paragraph. When the licences vary, the pair list is
  // the enumeration and the opening sentence stays generic; otherwise the
  // opening sentence carries the route list and the pair list is skipped.
  const intro = display.licencesVary
    ? `${displayName} is a licensed UK visa sponsor${locationClause}. Its UK Home Office sponsor licences are ${rating}.`
    : `${displayName} is a licensed UK ${routesText} visa sponsor${locationClause}, holding ${rating} sponsor status on the UK Home Office register.`;
  let background = '';
  if (incorporated && industry) {
    background = `The company was incorporated on ${incorporated} and operates in ${industry}.`;
  } else if (incorporated) {
    background = `The company was incorporated on ${incorporated}.`;
  } else if (industry) {
    background = `The company operates in ${industry}.`;
  }
  // Deliberately does NOT repeat the route list — the paragraph already
  // enumerated it once, in whichever sentence carried it.
  const outro = display.licencesVary
    ? `${displayName} can sponsor international workers on ${routes.length > 1 ? 'these routes' : 'this route'} under its current Home Office licence.`
    : `${displayName} can sponsor international workers for the UK ${routesText} ${routes.length > 1 ? 'visa routes' : 'visa'} under its current Home Office licence.`;
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
            <CompanyIndustry entries={sicEntries} />
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
              {/* Single licence: no pairing to confuse, so keep the compact
                  two-cell layout. Several: one field pairing each route with
                  the rating held ON that route — as two adjacent columns a
                  reader pairs them by eye, and a company can be A-rated on one
                  route and B-rated on another. */}
              {licences.length === 1 ? (
                <>
                  <DetailField
                    label="Visa Route"
                    value={titleCase(licences[0].route)}
                  />
                  <DetailField label="Rating" value={ratingsText} />
                </>
              ) : (
                <DetailField
                  label="Visa Routes & Ratings"
                  className="col-span-2 sm:col-span-4"
                  valueClassName="mt-1.5"
                  value={<LicenceStack items={licences} />}
                />
              )}
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

        {website && (
          <section className="mt-6" aria-labelledby="company-website-heading">
            <h2 id="company-website-heading" className={LABEL_CLASS}>
              Website
            </h2>
            {/* The domain, not the word "Website", so the reader can see where
                the link goes before taking it. How we confirmed it is
                deliberately not stated: that method is ours to keep. */}
            <a
              href={website.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-(--link-blue) no-underline hover:underline"
            >
              <Globe size={14} className="shrink-0" aria-hidden="true" />
              <span className="break-all">{displayDomain(website.url)}</span>
              <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
            </a>
          </section>
        )}

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
