import type { CHCompanyProfile } from './types.ts';

/**
 * Flatten a Companies House profile payload into a row shaped for the
 * `companies_house_profiles` table. Only keys present on the input are set on
 * the output so callers can diff partial stream updates against the existing
 * row without clobbering unspecified columns.
 */
export function mapProfileToRow(data: CHCompanyProfile) {
  const row: Record<string, unknown> = {
    companyNumber: data.company_number,
    companyName: data.company_name,
  };

  if (data.company_status !== undefined)
    row.companyStatus = data.company_status || null;
  if (data.type !== undefined) row.companyType = data.type || null;
  if (data.date_of_creation !== undefined)
    row.dateOfCreation = data.date_of_creation || null;

  if (data.registered_office_address !== undefined) {
    const addr = data.registered_office_address;
    row.addressLine1 = addr.address_line_1 || null;
    row.addressLine2 = addr.address_line_2 || null;
    row.locality = addr.locality || null;
    row.region = addr.region || null;
    row.postalCode = addr.postal_code || null;
    row.country = addr.country || null;
  }

  if (data.sic_codes !== undefined) row.sicCodes = data.sic_codes ?? [];
  if (data.jurisdiction !== undefined)
    row.jurisdiction = data.jurisdiction || null;
  if (data.has_been_liquidated !== undefined)
    row.hasBeenLiquidated = data.has_been_liquidated ?? null;
  if (data.has_insolvency_history !== undefined)
    row.hasInsolvencyHistory = data.has_insolvency_history ?? null;
  if (data.has_charges !== undefined) row.hasCharges = data.has_charges ?? null;
  if (data.previous_company_names !== undefined)
    row.previousCompanyNames =
      data.previous_company_names?.map((p) => p.name) ?? [];

  if (data.accounts !== undefined) {
    const acc = data.accounts;
    if (acc.next_made_up_to !== undefined)
      row.accountsNextMadeUpTo = acc.next_made_up_to || null;
    if (acc.last_accounts?.made_up_to !== undefined)
      row.accountsLastMadeUpTo = acc.last_accounts.made_up_to || null;
    if (acc.overdue !== undefined) row.accountsOverdue = acc.overdue ?? null;
  }

  if (data.confirmation_statement?.last_made_up_to !== undefined)
    row.confirmationStatementLastMadeUpTo =
      data.confirmation_statement.last_made_up_to || null;

  return row;
}
