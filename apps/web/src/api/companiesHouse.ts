import {
  companiesHouseProfiles,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
  toDatedPreviousNames,
} from '@ss/db';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { waitUntil } from '@vercel/functions';
import { asc, eq, isNull } from 'drizzle-orm';

import { db } from '../db.server';
import {
  PROFILE_UNAVAILABLE,
  profileStaleTime,
} from '../lib/company/profile-lookup';
import {
  type ChResponse,
  fetchChApi,
  fetchMappedProfile,
  resolveWithoutGaps,
} from '../lib/hmrc-ch/ch-lookup';
import {
  LONG_EDGE_CACHE,
  setCompanyCacheTag,
  setRpcCacheControl,
  TRANSIENT_EDGE_CACHE,
} from './cache-headers';
import { loadSicDescriptions } from './sic';

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
  previous_company_names?: {
    name: string;
    effective_from?: string;
    ceased_on?: string;
  }[];
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
      profile.previous_company_names?.map((p) => p.name).filter((n) => !!n) ??
      [],
    previousCompanyNamesDated: toDatedPreviousNames(
      profile.previous_company_names,
    ),
    confirmationStatementLastMadeUpTo:
      profile.confirmation_statement?.last_made_up_to || null,
    updatedAt: new Date(),
  };
}

/**
 * Call the Companies House REST API with the server's key. Never throws for
 * a failed call (see `fetchChApi`); throws only when the API key env var is
 * missing.
 */
async function fetchFromApi(path: string): Promise<ChResponse> {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY is not set');
  return fetchChApi(path, apiKey);
}

/** getCompanyProfile's result for a transient Companies House failure, edge-cached only long enough to absorb a retry burst. */
function profileUnavailable() {
  setRpcCacheControl(TRANSIENT_EDGE_CACHE);
  return PROFILE_UNAVAILABLE;
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
 * `null` when Companies House has no such company (verified no-match, public
 * body, 404) and `PROFILE_UNAVAILABLE` when a CH call failed transiently, in
 * which case nothing is persisted.
 */
const getCompanyProfile = createServerFn()
  .validator((input: unknown) => input as { companyName: string })
  .handler(async ({ data: { companyName } }) => {
    // Look up company number via mapping table
    const [mapping] = await db
      .select()
      .from(hmrcCompanyMapping)
      .where(eq(hmrcCompanyMapping.organisationName, companyName))
      .limit(1);

    let profile: CompanyProfile;

    // Never-verified ingestion stubs (companyNumber NULL, verifiedAt NULL —
    // seeded by ingest-hmrc-csv.ts Step 8 for orgs new to the register) fall
    // through to the on-demand resolver below, so a first visit still
    // resolves immediately; the nightly sweep covers the unvisited rest.
    const isUnresolvedStub =
      mapping != null && !mapping.companyNumber && mapping.verifiedAt === null;

    if (mapping && !isUnresolvedStub) {
      // Mapping deliberately points at no CH entity (public body or no_match
      // outcome from the Phase 1 backfill or a completed sweep). Return null
      // so the UI suppresses the CH panel and renders base sponsor data only.
      if (!mapping.companyNumber) return null;

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
        const fetched = await fetchMappedProfile(
          mapping.companyNumber,
          fetchFromApi,
        );

        if (fetched.verdict === 'absent') return null;
        if (fetched.verdict === 'unavailable') {
          console.log(
            `[Profile] CH failure for ${mapping.companyNumber} — reporting unavailable`,
          );
          return profileUnavailable();
        }

        profile = fetched.profile as CompanyProfile;
        waitUntil(upsertProfile(profile));
      }
    } else {
      // No mapping — run the verified resolution pipeline (parse → search →
      // tier scoring → locality tiebreak → fail closed). Same code path the
      // bootstrap seed uses; replaces the legacy items_per_page=1 take-the-
      // top-hit logic that was silently mapping new sponsors to wrong CH
      // entities. See docs/hmrc-ch-mapping-fix.md "Phase 3 — on-demand
      // resolver hardening".
      console.log(
        `[Profile] no mapping, resolving via CH for: "${companyName}"`,
      );
      // Town/county feed the locality tiebreak; `asc(id)` mirrors
      // makeLookupSponsor's deterministic first-row pick (one arbitrary
      // site for multi-site orgs).
      const [hmrcRow] = await db
        .select({
          townCity: hmrcSkilledWorkers.townCity,
          county: hmrcSkilledWorkers.county,
        })
        .from(hmrcSkilledWorkers)
        .where(eq(hmrcSkilledWorkers.organisationName, companyName))
        .orderBy(asc(hmrcSkilledWorkers.id))
        .limit(1);
      const result = await resolveWithoutGaps(
        companyName,
        {
          townCity: hmrcRow?.townCity ?? null,
          county: hmrcRow?.county ?? null,
        },
        fetchFromApi,
      );

      // Any verdict reached without a CH answer is an artifact of the outage,
      // not evidence — report unavailable and cache nothing, so the next
      // visit retries instead of inheriting a poisoned mapping.
      if (result.verdict === 'unavailable') {
        console.log(
          `[Profile] CH failure while resolving "${companyName}" — not caching a verdict`,
        );
        return profileUnavailable();
      }

      if (result.verdict === 'public_body') {
        // Claim a never-verified ingestion stub if one exists; the verified_at
        // guard means a sweep- or manually-resolved row is never clobbered.
        const publicBodyRow = {
          organisationName: companyName,
          companyNumber: null,
          isPublicBody: true,
          matchMethod: 'public_body',
          verifiedAt: new Date(),
        };
        waitUntil(
          db
            .insert(hmrcCompanyMapping)
            .values(publicBodyRow)
            .onConflictDoUpdate({
              target: hmrcCompanyMapping.organisationName,
              set: publicBodyRow,
              setWhere: isNull(hmrcCompanyMapping.verifiedAt),
            }),
        );
        return null;
      }

      if (result.verdict === 'no_match' || result.verdict === 'human_review') {
        // human_review (multiple tied candidates) is cached as no_match for the
        // on-demand path: re-running the 5-call pipeline on every visit would
        // be expensive and the verdict won't change without ch-stream data
        // updates. Phase 5 re-verification can revisit later.
        const noMatchRow = {
          organisationName: companyName,
          companyNumber: null,
          matchMethod: 'no_match',
          queryUsed: result.queryUsed,
          verifiedAt: new Date(),
        };
        waitUntil(
          db
            .insert(hmrcCompanyMapping)
            .values(noMatchRow)
            .onConflictDoUpdate({
              target: hmrcCompanyMapping.organisationName,
              set: noMatchRow,
              setWhere: isNull(hmrcCompanyMapping.verifiedAt),
            }),
        );
        return null;
      }

      // verdict === 'verified' — CHFullProfile and CompanyProfile come from the
      // same CH endpoint, so a structural cast is safe.
      profile = result.profile as CompanyProfile;
      const verifiedRow = {
        organisationName: companyName,
        companyNumber: result.companyNumber,
        matchMethod: result.matchMethod,
        matchScore: result.matchScore.toString(),
        queryUsed: result.queryUsed,
        verifiedAt: new Date(),
      };
      waitUntil(
        Promise.all([
          db
            .insert(hmrcCompanyMapping)
            .values(verifiedRow)
            .onConflictDoUpdate({
              target: hmrcCompanyMapping.organisationName,
              set: verifiedRow,
              setWhere: isNull(hmrcCompanyMapping.verifiedAt),
            }),
          upsertProfile(profile),
        ]),
      );
    }

    // Look up SIC code descriptions from our database
    const sicDescriptions = await loadSicDescriptions(profile.sic_codes ?? []);

    setCompanyCacheTag(profile.company_number);

    setRpcCacheControl(LONG_EDGE_CACHE);

    return {
      kind: 'found' as const,
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
      company_name: profile.company_name,
      previousNames:
        profile.previous_company_names?.map((p) => p.name).filter((n) => !!n) ??
        [],
      sicDescriptions,
    };
  });

/**
 * React Query options for `getCompanyProfile`. Keyed by `companyName` to
 * match the server fn's input and dedupe across HMRC rows that share an
 * organisation name but differ by visa route / type-rating. Private: read
 * through `fetchCompanyProfile`, never ensureQueryData, which ignores
 * staleTime and would keep a transient failure until it is garbage-collected.
 */
const companyProfileQueryOptions = (companyName: string) =>
  queryOptions({
    queryKey: ['company-profile', companyName],
    queryFn: () => getCompanyProfile({ data: { companyName } }),
    staleTime: (query) => profileStaleTime(query.state.data),
  });

/** Reads a company's profile through the client cache, honouring staleTime so a cached transient failure is retried once it goes stale. */
export function fetchCompanyProfile(
  queryClient: QueryClient,
  companyName: string,
) {
  return queryClient.query(companyProfileQueryOptions(companyName));
}
