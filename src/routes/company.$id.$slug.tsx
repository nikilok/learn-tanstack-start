import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ExternalLink, MapPin } from 'lucide-react';
import { getCompanyProfile, searchCompany } from '../api/companiesHouse';
import { getHmrcById } from '../api/hmrc';
import { titleCase } from '../utils';
import { buildCanonical } from '../utils/canonical';

export const Route = createFileRoute('/company/$id/$slug')({
  validateSearch: (search: Record<string, unknown>) => ({
    search: ((search.search as string) || '').trim(),
  }),
  loader: async ({ params }) => {
    const sponsor = await getHmrcById({ data: { slugId: params.id } });

    if (!sponsor) {
      throw notFound();
    }

    const searchResult = await searchCompany({
      data: { query: sponsor.organisationName },
    });

    const profile = searchResult
      ? await getCompanyProfile({
          data: { companyNumber: searchResult.company_number },
        })
      : null;

    return { sponsor, profile };
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
    return {
      meta: [
        {
          title: `${name} - UK Visa Sponsor | SponsorSearch`,
        },
        {
          name: 'description',
          content: location
            ? `${name} in ${location} — licensed UK ${titleCase(loaderData?.sponsor.route ?? 'Skilled Worker')} visa sponsor. View sponsor details, ratings, and company information.`
            : `${name} — licensed UK visa sponsor. View sponsor details, ratings, and company information.`,
        },
      ],
      links: [
        {
          rel: 'canonical',
          href: buildCanonical(
            match.pathname,
            match.search as Record<string, string>,
          ),
        },
      ],
    };
  },
  component: CompanyDetail,
});

function formatAddress(
  address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  } | null,
) {
  if (!address) return '';
  return [
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.region,
    address.postal_code,
    address.country,
  ]
    .filter(Boolean)
    .join(', ');
}

function formatDate(dateStr?: string | null) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function StatusBadge({ status }: { status: string }) {
  const isActive = status === 'active';
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${
        isActive
          ? 'border border-[#16a34a]/40 text-[#16a34a]'
          : 'border border-[#dc2626]/40 text-[#dc2626]'
      }`}
    >
      {titleCase(status)}
    </span>
  );
}

function CompanyDetail() {
  const { sponsor, profile } = Route.useLoaderData();
  const { search } = Route.useSearch();

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <div className="rounded-lg bg-(--sponsor-card-bg) shadow-(--shadow-card) p-6">
          <h1 className="text-xl font-semibold text-(--sea-ink)">
            {titleCase(sponsor.organisationName)}
          </h1>
          {profile?.sicDescriptions && profile.sicDescriptions.length > 0 && (
            <p className="mt-1 text-sm text-(--sea-ink-soft)">
              {profile.sicDescriptions.map((sic) => sic.description).join(', ')}
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
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        <Link
          to="/"
          search={{ search }}
          className="no-underline mt-6 block w-full px-4 py-3 text-center text-sm font-medium text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
        >
          &larr; Back to search
        </Link>
      </section>
    </main>
  );
}
