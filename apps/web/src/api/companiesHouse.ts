import { companiesHouseProfiles, hmrcCompanyMapping, sicCodes } from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { waitUntil } from '@vercel/functions';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db.server';
import { setRpcCacheControl } from './cache-headers';

const BASE_URL = 'https://api.company-information.service.gov.uk';

type CompanyProfile = {
  company_name: string;
  company_number: string;
  company_status: string;
  type: string;
  date_of_creation: string;
  registered_office_address: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
  sic_codes?: string[];
  accounts?: {
    next_made_up_to?: string;
    last_accounts?: { made_up_to?: string };
    overdue?: boolean;
  };
  jurisdiction?: string;
  has_been_liquidated?: boolean;
  has_insolvency_history?: boolean;
  has_charges?: boolean;
  previous_company_names?: { name: string }[];
  confirmation_statement?: {
    last_made_up_to?: string;
  };
};

/**
 * Map a `companies_house_profiles` DB row into the nested `CompanyProfile`
 * shape returned by the Companies House REST API, using `undefined` for
 * missing optional fields so the object round-trips cleanly to JSON.
 */
function dbRowToProfile(
  row: typeof companiesHouseProfiles.$inferSelect,
): CompanyProfile {
  return {
    company_name: row.companyName,
    company_number: row.companyNumber,
    company_status: row.companyStatus ?? '',
    type: row.companyType ?? '',
    date_of_creation: row.dateOfCreation ?? '',
    registered_office_address: {
      address_line_1: row.addressLine1 ?? undefined,
      address_line_2: row.addressLine2 ?? undefined,
      locality: row.locality ?? undefined,
      region: row.region ?? undefined,
      postal_code: row.postalCode ?? undefined,
      country: row.country ?? undefined,
    },
    sic_codes: row.sicCodes ?? [],
    accounts: {
      next_made_up_to: row.accountsNextMadeUpTo ?? undefined,
      last_accounts: {
        made_up_to: row.accountsLastMadeUpTo ?? undefined,
      },
      overdue: row.accountsOverdue ?? undefined,
    },
    jurisdiction: row.jurisdiction ?? undefined,
    has_been_liquidated: row.hasBeenLiquidated ?? undefined,
    has_insolvency_history: row.hasInsolvencyHistory ?? undefined,
    has_charges: row.hasCharges ?? undefined,
    previous_company_names:
      row.previousCompanyNames?.map((name) => ({ name })) ?? [],
    confirmation_statement: {
      last_made_up_to: row.confirmationStatementLastMadeUpTo ?? undefined,
    },
  };
}

/**
 * Flatten a `CompanyProfile` API payload into a `companies_house_profiles`
 * row for insert/upsert — coerces empty strings to `null` and stamps a fresh
 * `updatedAt`.
 */
function profileToDbRow(profile: CompanyProfile) {
  return {
    companyNumber: profile.company_number,
    companyName: profile.company_name,
    companyStatus: profile.company_status || null,
    companyType: profile.type || null,
    dateOfCreation: profile.date_of_creation || null,
    addressLine1: profile.registered_office_address?.address_line_1 || null,
    addressLine2: profile.registered_office_address?.address_line_2 || null,
    locality: profile.registered_office_address?.locality || null,
    region: profile.registered_office_address?.region || null,
    postalCode: profile.registered_office_address?.postal_code || null,
    country: profile.registered_office_address?.country || null,
    sicCodes: profile.sic_codes ?? [],
    accountsNextMadeUpTo: profile.accounts?.next_made_up_to || null,
    accountsLastMadeUpTo: profile.accounts?.last_accounts?.made_up_to || null,
    accountsOverdue: profile.accounts?.overdue ?? null,
    jurisdiction: profile.jurisdiction || null,
    hasBeenLiquidated: profile.has_been_liquidated ?? null,
    hasInsolvencyHistory: profile.has_insolvency_history ?? null,
    hasCharges: profile.has_charges ?? null,
    previousCompanyNames:
      profile.previous_company_names?.map((p) => p.name) ?? [],
    confirmationStatementLastMadeUpTo:
      profile.confirmation_statement?.last_made_up_to || null,
    updatedAt: new Date(),
  };
}

/**
 * Call the Companies House REST API with Basic auth. Returns a discriminated
 * result — `{ ok: true, data }` on success, `{ ok: false, status }` for any
 * non-2xx (including 429 rate-limits). Throws only when the API key env var
 * is missing.
 */
async function fetchFromApi(
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY is not set');

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    },
  });

  if (res.status === 429) {
    return { ok: false, status: 429 };
  }

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  return { ok: true, data: await res.json() };
}

/**
 * Upsert a `CompanyProfile` into `companies_house_profiles` keyed on
 * `companyNumber`, overwriting all tracked fields on conflict.
 */
async function upsertProfile(profile: CompanyProfile) {
  const row = profileToDbRow(profile);
  await db.insert(companiesHouseProfiles).values(row).onConflictDoUpdate({
    target: companiesHouseProfiles.companyNumber,
    set: row,
  });
}

/**
 * Server fn resolving a company profile for a given HMRC organisation name.
 * Looks up the company number via `hmrc_company_mapping`, returns the cached
 * profile if present, otherwise calls the Companies House API (search →
 * profile) and persists the mapping + profile via `waitUntil`. Returns
 * `null` when no match is found or any upstream call fails.
 */
export const getCompanyProfile = createServerFn()
  .inputValidator((input: unknown) => input as { companyName: string })
  .handler(async ({ data: { companyName } }) => {
    // Look up company number via mapping table
    const [mapping] = await db
      .select()
      .from(hmrcCompanyMapping)
      .where(eq(hmrcCompanyMapping.organisationName, companyName))
      .limit(1);

    let profile: CompanyProfile;

    if (mapping) {
      // Found mapping — fetch profile from cache
      const [cached] = await db
        .select()
        .from(companiesHouseProfiles)
        .where(eq(companiesHouseProfiles.companyNumber, mapping.companyNumber))
        .limit(1);

      if (cached) {
        console.log(`[Profile] cache hit: "${cached.companyName}"`);
        profile = dbRowToProfile(cached);
      } else {
        // Mapping exists but profile missing — fetch from API
        console.log(
          `[Profile] mapping found but no profile, calling API for: ${mapping.companyNumber}`,
        );
        const profileResult = await fetchFromApi(
          `/company/${mapping.companyNumber}`,
        );

        if (!profileResult.ok) return null;

        profile = profileResult.data as CompanyProfile;
        waitUntil(upsertProfile(profile));
      }
    } else {
      // No mapping — search API for company number, then fetch profile
      console.log(`[Profile] no mapping, calling API for: "${companyName}"`);
      const searchResult = await fetchFromApi(
        `/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=1`,
      );

      if (!searchResult.ok) return null;

      const searchData = searchResult.data as {
        items?: { company_number: string }[];
      };
      if (!searchData.items?.length) return null;

      const companyNumber = searchData.items[0].company_number;

      const profileResult = await fetchFromApi(`/company/${companyNumber}`);

      if (!profileResult.ok) return null;

      profile = profileResult.data as CompanyProfile;
      // Save mapping and profile after response is sent
      waitUntil(
        Promise.all([
          db
            .insert(hmrcCompanyMapping)
            .values({ organisationName: companyName, companyNumber })
            .onConflictDoNothing(),
          upsertProfile(profile),
        ]),
      );
    }

    // Look up SIC code descriptions from our database
    let sicDescriptions: { code: string; description: string }[] = [];
    if (profile.sic_codes?.length) {
      sicDescriptions = await db
        .select({
          code: sicCodes.code,
          description: sicCodes.description,
        })
        .from(sicCodes)
        .where(inArray(sicCodes.code, profile.sic_codes));
    }

    setResponseHeader(
      'x-vercel-cache-tag',
      `company-${profile.company_number}`,
    );

    // RPC calls don't inherit the Nitro route rule's s-maxage, so set it explicitly
    setRpcCacheControl('s-maxage=2592000, stale-while-revalidate=604800');

    return {
      company_number: profile.company_number,
      company_status: profile.company_status,
      type: profile.type,
      date_of_creation: profile.date_of_creation,
      registered_office_address: profile.registered_office_address,
      accounts: profile.accounts?.last_accounts?.made_up_to
        ? {
            last_accounts: {
              made_up_to: profile.accounts.last_accounts.made_up_to,
            },
          }
        : undefined,
      sicDescriptions,
    };
  });

/**
 * React Query options for `getCompanyProfile`. Keyed by `companyName` to
 * match the server fn's input and dedupe across HMRC rows that share an
 * organisation name but differ by visa route / type-rating. Uses the
 * router-level default `staleTime` (5 min).
 */
export const companyProfileQueryOptions = (companyName: string) =>
  queryOptions({
    queryKey: ['company-profile', companyName],
    queryFn: () => getCompanyProfile({ data: { companyName } }),
  });
