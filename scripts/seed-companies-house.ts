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

import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/neon-http";
import { companiesHouseProfiles } from "../src/db/schema";

dotenv.config({ path: ".env.local" });

const sql = neon(process.env.POSTGRES_URL as string);
const db = drizzle({ client: sql });

const BASE_URL = "https://api.company-information.service.gov.uk";
const API_KEY = process.env.COMPANIES_HOUSE_SEED_API_KEY as string;
if (!API_KEY)
  throw new Error(
    "Set COMPANIES_HOUSE_SEED_API_KEY in .env.local (use a separate key from production)",
  );

const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`;

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
    console.log("  Rate limited, backing off for 60s...");
    await sleep(60_000);
    return fetchApi(path);
  }

  if (!res.ok) {
    return null;
  }

  return res.json();
}

// Get all distinct org names
const allOrgs = await sql`
  SELECT DISTINCT organisation_name
  FROM hmrc_skilled_workers
  ORDER BY organisation_name
`;
console.log(`Found ${allOrgs.length} unique organisations`);

// Get already-cached company names to skip
const cached = await sql`SELECT company_name FROM companies_house_profiles`;
const cachedNames = new Set(
  cached.map((r) => (r.company_name as string).toUpperCase()),
);
console.log(`Already cached: ${cachedNames.size} — skipping those`);

let processed = 0;
let inserted = 0;
let skipped = 0;
let failed = 0;
const startTime = Date.now();
const remaining = allOrgs.length - cachedNames.size;

function formatEta(ms: number) {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function logProgress() {
  const elapsed = Date.now() - startTime;
  const apiCalls = inserted + failed; // only non-skipped items hit the API
  const rate = apiCalls > 0 ? elapsed / apiCalls : DELAY_MS * 2;
  const left = remaining - apiCalls;
  const eta = formatEta(left * rate);
  console.log(
    `[${processed}/${allOrgs.length}] inserted=${inserted} skipped=${skipped} failed=${failed} | ETA: ${eta}`,
  );
}

for (const row of allOrgs) {
  const orgName = row.organisation_name as string;
  processed++;

  // Skip if already cached (case-insensitive match)
  if (cachedNames.has(orgName.toUpperCase())) {
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
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: companiesHouseProfiles.companyNumber,
      set: {
        companyName: profile.company_name,
        companyStatus: profile.company_status || null,
        companyType: profile.type || null,
        updatedAt: new Date(),
      },
    });

  inserted++;
  cachedNames.add(profile.company_name.toUpperCase());

  if (processed % 100 === 0) {
    logProgress();
  }
}

console.log(
  `\nDone! Processed=${processed} Inserted=${inserted} Skipped=${skipped} Failed=${failed}`,
);
