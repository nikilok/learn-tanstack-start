import { createServerFn } from '@tanstack/react-start';
import { eq, ilike, inArray } from 'drizzle-orm';
import { db } from '../db';
import { companiesHouseProfiles, sicCodes } from '../db/schema';

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
  };
};

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
    },
  };
}

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
    updatedAt: new Date(),
  };
}

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

async function upsertProfile(profile: CompanyProfile) {
  const row = profileToDbRow(profile);
  await db.insert(companiesHouseProfiles).values(row).onConflictDoUpdate({
    target: companiesHouseProfiles.companyNumber,
    set: row,
  });
}

export const searchCompany = createServerFn()
  .inputValidator((input: unknown) => input as { query: string })
  .handler(async ({ data: { query } }) => {
    const result = await fetchFromApi(
      `/search/companies?q=${encodeURIComponent(query)}&items_per_page=1`,
    );

    if (result.ok) {
      const data = result.data as {
        items?: {
          company_number: string;
          title: string;
          company_status: string;
          date_of_creation: string;
          address_snippet: string;
        }[];
      };
      if (!data.items?.length) return null;
      return data.items[0];
    }

    // On 429 or other errors, fall back to cached data
    const [cached] = await db
      .select()
      .from(companiesHouseProfiles)
      .where(ilike(companiesHouseProfiles.companyName, query))
      .limit(1);

    if (cached) {
      return {
        company_number: cached.companyNumber,
        title: cached.companyName,
        company_status: cached.companyStatus ?? '',
        date_of_creation: cached.dateOfCreation ?? '',
        address_snippet: [
          cached.addressLine1,
          cached.locality,
          cached.postalCode,
        ]
          .filter(Boolean)
          .join(', '),
      };
    }

    throw new Error(
      `Companies House API error: ${result.status} and no cached data available`,
    );
  });

export const getCompanyProfile = createServerFn()
  .inputValidator((input: unknown) => input as { companyNumber: string })
  .handler(async ({ data: { companyNumber } }) => {
    const result = await fetchFromApi(`/company/${companyNumber}`);

    let profile: CompanyProfile;

    if (result.ok) {
      profile = result.data as CompanyProfile;
      // Update cache in the background — don't block the response
      upsertProfile(profile).catch(() => {});
    } else {
      // On 429 or other errors, fall back to cached data
      const [cached] = await db
        .select()
        .from(companiesHouseProfiles)
        .where(eq(companiesHouseProfiles.companyNumber, companyNumber))
        .limit(1);

      if (!cached) {
        throw new Error(
          `Companies House API error: ${result.status} and no cached data available`,
        );
      }

      profile = dbRowToProfile(cached);
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

    return { ...profile, sicDescriptions };
  });
