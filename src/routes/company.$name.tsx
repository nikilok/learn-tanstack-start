import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { getCompanyProfile, searchCompany } from '../api/companiesHouse';
import { titleCase } from '../utils';

export const Route = createFileRoute('/company/$name')({
  loader: async ({ params }) => {
    const companyName = decodeURIComponent(params.name);
    const searchResult = await searchCompany({
      data: { query: companyName },
    });

    if (!searchResult) {
      return { profile: null, companyName };
    }

    const profile = await getCompanyProfile({
      data: { companyNumber: searchResult.company_number },
    });

    return { profile, companyName };
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

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-GB', {
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
        isActive ? 'bg-[#16a34a] text-white' : 'bg-[#dc2626] text-white'
      }`}
    >
      {titleCase(status)}
    </span>
  );
}

function CompanyDetail() {
  const { profile, companyName } = Route.useLoaderData();

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="mb-6 inline-block cursor-pointer text-sm text-(--sea-ink-soft) hover:text-(--sea-ink)"
        >
          &larr; Back to search
        </button>

        {!profile ? (
          <div className="glass rounded-lg p-6">
            <h1 className="text-xl font-semibold text-(--sea-ink)">
              {titleCase(companyName)}
            </h1>
            <p className="mt-4 text-(--sea-ink-soft)">
              No matching company found on Companies House.
            </p>
          </div>
        ) : (
          <div className="glass rounded-lg p-6">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-xl font-semibold text-(--sea-ink)">
                {titleCase(profile.company_name)}
              </h1>
              <StatusBadge status={profile.company_status} />
            </div>

            <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
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

              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                  Company Type
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {titleCase(profile.type.replace(/-/g, ' '))}
                </dd>
              </div>

              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                  Incorporated
                </dt>
                <dd className="mt-1 text-sm text-(--sea-ink)">
                  {formatDate(profile.date_of_creation)}
                </dd>
              </div>

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

              <div className="col-span-2 sm:col-span-4">
                <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                  Registered Address
                </dt>
                <dd className="mt-1 text-sm">
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(profile.registered_office_address))}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="no-underline inline-flex items-center gap-1 text-(--sea-ink-soft) hover:text-(--sea-ink)"
                  >
                    {formatAddress(profile.registered_office_address)}
                    <ExternalLink size={12} className="shrink-0" />
                  </a>
                </dd>
              </div>

              {profile.sicDescriptions.length > 0 && (
                <div className="col-span-2 sm:col-span-4">
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-(--sea-ink-soft)">
                    Industry
                  </dt>
                  <dd className="mt-1 text-sm text-(--sea-ink)">
                    {profile.sicDescriptions
                      .map((sic) => sic.description)
                      .join(', ')}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </section>
    </main>
  );
}
