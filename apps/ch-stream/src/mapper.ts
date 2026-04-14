import type { CHCompanyProfile } from './types.ts';

export function mapProfileToRow(data: CHCompanyProfile) {
  return {
    companyNumber: data.company_number,
    companyName: data.company_name,
    companyStatus: data.company_status || null,
    companyType: data.type || null,
    dateOfCreation: data.date_of_creation || null,
    addressLine1: data.registered_office_address?.address_line_1 || null,
    addressLine2: data.registered_office_address?.address_line_2 || null,
    locality: data.registered_office_address?.locality || null,
    region: data.registered_office_address?.region || null,
    postalCode: data.registered_office_address?.postal_code || null,
    country: data.registered_office_address?.country || null,
    sicCodes: data.sic_codes ?? [],
    accountsNextMadeUpTo: data.accounts?.next_made_up_to || null,
    accountsLastMadeUpTo: data.accounts?.last_accounts?.made_up_to || null,
    accountsOverdue: data.accounts?.overdue ?? null,
    jurisdiction: data.jurisdiction || null,
    hasBeenLiquidated: data.has_been_liquidated ?? null,
    hasInsolvencyHistory: data.has_insolvency_history ?? null,
    hasCharges: data.has_charges ?? null,
    previousCompanyNames: data.previous_company_names?.map((p) => p.name) ?? [],
    confirmationStatementLastMadeUpTo:
      data.confirmation_statement?.last_made_up_to || null,
  };
}

export type ProfileRow = ReturnType<typeof mapProfileToRow>;

export type DiffableColumn = keyof Omit<ProfileRow, 'companyNumber'>;

export const DIFFABLE_COLUMNS: DiffableColumn[] = Object.keys(
  mapProfileToRow({
    company_number: '',
    company_name: '',
  }),
).filter((k): k is DiffableColumn => k !== 'companyNumber');
