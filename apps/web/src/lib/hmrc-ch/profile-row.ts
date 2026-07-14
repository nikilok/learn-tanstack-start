/**
 * Pure mapping from a CH `/company/{number}` payload to the
 * `companies_house_profiles` row shape. Shared by the standalone scripts
 * (phase5 sweep, bulk snapshot matcher) so the column mapping can't drift
 * between writers; `apps/web/src/api/companiesHouse.ts` keeps its own copy
 * wired to the TanStack Start runtime types.
 */

import { toDatedPreviousNames } from '@ss/db';

import type { CHFullProfile } from '../phase5/apply-promotion.ts';

type CHRegisteredAddress = {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

type CHAccounts = {
  next_made_up_to?: string;
  last_accounts?: { made_up_to?: string };
  overdue?: boolean;
};

/** Flattens a CH profile payload into the profiles-table row shape. */
export function profileToDbRow(profile: CHFullProfile) {
  const address = (profile.registered_office_address ??
    {}) as CHRegisteredAddress;
  const accounts = (profile.accounts ?? {}) as CHAccounts;
  const previousNames = (profile.previous_company_names ?? []) as {
    name: string;
    effective_from?: string;
    ceased_on?: string;
  }[];
  const confirmation = (profile.confirmation_statement ?? {}) as {
    last_made_up_to?: string;
  };

  return {
    companyNumber: profile.company_number,
    companyName: profile.company_name,
    companyStatus: profile.company_status ?? null,
    companyType: (profile.type as string | undefined) ?? null,
    dateOfCreation: (profile.date_of_creation as string | undefined) ?? null,
    addressLine1: address.address_line_1 ?? null,
    addressLine2: address.address_line_2 ?? null,
    locality: address.locality ?? null,
    region: address.region ?? null,
    postalCode: address.postal_code ?? null,
    country: address.country ?? null,
    sicCodes: (profile.sic_codes as string[] | undefined) ?? [],
    accountsNextMadeUpTo: accounts.next_made_up_to ?? null,
    accountsLastMadeUpTo: accounts.last_accounts?.made_up_to ?? null,
    accountsOverdue: accounts.overdue ?? null,
    jurisdiction: (profile.jurisdiction as string | undefined) ?? null,
    hasBeenLiquidated:
      (profile.has_been_liquidated as boolean | undefined) ?? null,
    hasInsolvencyHistory:
      (profile.has_insolvency_history as boolean | undefined) ?? null,
    hasCharges: (profile.has_charges as boolean | undefined) ?? null,
    previousCompanyNames: previousNames.map((p) => p.name).filter((n) => !!n),
    previousCompanyNamesDated: toDatedPreviousNames(previousNames),
    confirmationStatementLastMadeUpTo: confirmation.last_made_up_to ?? null,
    updatedAt: new Date(),
  };
}
