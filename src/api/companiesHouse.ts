import { createServerFn } from '@tanstack/react-start';
import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { sicCodes } from '../db/schema';

const BASE_URL = 'https://api.company-information.service.gov.uk';

export const searchCompany = createServerFn()
  .inputValidator((input: unknown) => input as { query: string })
  .handler(async ({ data: { query } }) => {
    const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
    if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY is not set');

    const res = await fetch(
      `${BASE_URL}/search/companies?q=${encodeURIComponent(query)}&items_per_page=1`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        },
      },
    );

    if (!res.ok) {
      throw new Error(
        `Companies House API error: ${res.status} ${res.statusText}`,
      );
    }

    const data = await res.json();
    if (!data.items?.length) return null;

    return data.items[0] as {
      company_number: string;
      title: string;
      company_status: string;
      date_of_creation: string;
      address_snippet: string;
    };
  });

export const getCompanyProfile = createServerFn()
  .inputValidator((input: unknown) => input as { companyNumber: string })
  .handler(async ({ data: { companyNumber } }) => {
    const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
    if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY is not set');

    const res = await fetch(`${BASE_URL}/company/${companyNumber}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      },
    });

    if (!res.ok) {
      throw new Error(
        `Companies House API error: ${res.status} ${res.statusText}`,
      );
    }

    const profile = (await res.json()) as {
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
