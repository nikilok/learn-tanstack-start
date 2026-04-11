/**
 * Seed script: fetches Companies House profiles for all HMRC sponsors.
 *
 * Run locally with:  bun scripts/seed-companies-house.ts
 *
 * - Fetches distinct org names from hmrc_skilled_workers
 * - For each, searches Companies House API → fetches full profile → upserts into DB
 * - Throttled to ~2 req/sec (600 requests per 5 min rate limit)
 * - Resumable: skips companies already in companies_house_profiles
 * - Logs progress every 100 companies
 */

import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/neon-http';
import { companiesHouseProfiles, hmrcCompanyMapping } from '../src/db/schema';

dotenv.config({ path: '.env.local' });

const sql = neon(process.env.POSTGRES_URL as string);
const db = drizzle({ client: sql });

const BASE_URL = 'https://api.company-information.service.gov.uk';
const API_KEY = process.env.COMPANIES_HOUSE_SEED_API_KEY as string;
if (!API_KEY)
  throw new Error(
    'Set COMPANIES_HOUSE_SEED_API_KEY in .env.local (use a separate key from production)',
  );

const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`;

// ~2 requests per second to stay within 600/5min
const DELAY_MS = 550;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchApi(path: string): Promise<unknown | null> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: AUTH_HEADER },
  });

  if (res.status === 429) {
    // Rate limited — back off for 60 seconds then retry
    console.log('  Rate limited, backing off for 60s...');
    await sleep(60_000);
    return fetchApi(path);
  }

  if (!res.ok) {
    return null;
  }

  return res.json();
}

// Get only org names that aren't already cached
const uncached = await sql`
  SELECT DISTINCT h.organisation_name
  FROM hmrc_skilled_workers h
  LEFT JOIN companies_house_profiles c
    ON UPPER(h.organisation_name) = UPPER(c.company_name)
  WHERE c.company_number IS NULL
  ORDER BY h.organisation_name
`;
console.log(`Found ${uncached.length} uncached organisations to fetch`);

let processed = 0;
let inserted = 0;
let skipped = 0;
let failed = 0;
const startTime = Date.now();
const total = uncached.length;

function formatEta(ms: number) {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function logProgress() {
  const elapsed = Date.now() - startTime;
  const apiCalls = inserted + failed;
  const rate = apiCalls > 0 ? elapsed / apiCalls : DELAY_MS * 2;
  const left = total - processed;
  const eta = formatEta(left * rate);
  console.log(
    `[${processed}/${total}] inserted=${inserted} skipped=${skipped} failed=${failed} | ETA: ${eta}`,
  );
}

for (const row of uncached) {
  const orgName = row.organisation_name as string;
  processed++;

  // Check if a crawler cached this while the seed was running
  const [alreadyCached] = await sql`
    SELECT 1 FROM companies_house_profiles
    WHERE UPPER(company_name) = ${orgName.toUpperCase()}
    LIMIT 1
  `;
  if (alreadyCached) {
    skipped++;
    if (processed % 100 === 0) {
      logProgress();
    }
    continue;
  }

  // 1. Search for company number
  await sleep(DELAY_MS);
  const searchData = (await fetchApi(
    `/search/companies?q=${encodeURIComponent(orgName)}&items_per_page=1`,
  )) as { items?: { company_number: string }[] } | null;

  if (!searchData?.items?.length) {
    failed++;
    if (processed % 100 === 0) {
      logProgress();
    }
    continue;
  }

  const companyNumber = searchData.items[0].company_number;

  // Store HMRC org name → company number mapping
  await db
    .insert(hmrcCompanyMapping)
    .values({ organisationName: orgName, companyNumber })
    .onConflictDoNothing();

  // 2. Fetch full profile
  await sleep(DELAY_MS);
  const profile = (await fetchApi(`/company/${companyNumber}`)) as {
    company_name: string;
    company_number: string;
    company_status?: string;
    type?: string;
    date_of_creation?: string;
    registered_office_address?: {
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
  } | null;

  if (!profile) {
    failed++;
    if (processed % 100 === 0) {
      logProgress();
    }
    continue;
  }

  // 3. Upsert into DB
  await db
    .insert(companiesHouseProfiles)
    .values({
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
    })
    .onConflictDoUpdate({
      target: companiesHouseProfiles.companyNumber,
      set: {
        companyName: profile.company_name,
        companyStatus: profile.company_status || null,
        companyType: profile.type || null,
        sicCodes: profile.sic_codes ?? [],
        accountsNextMadeUpTo: profile.accounts?.next_made_up_to || null,
        accountsLastMadeUpTo:
          profile.accounts?.last_accounts?.made_up_to || null,
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
      },
    });

  inserted++;

  if (processed % 100 === 0) {
    logProgress();
  }
}

console.log(
  `\nDone! Processed=${processed} Inserted=${inserted} Skipped=${skipped} Failed=${failed}`,
);
