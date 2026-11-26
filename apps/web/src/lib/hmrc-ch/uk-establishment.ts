/**
 * The register's own link between an overseas company and its UK
 * establishments, read by number and never by name. Pure, no I/O.
 */

import { COMPANY_NUMBER_RE } from '../company/ids';

/** An establishment as Companies House lists it under an overseas company. */
export type ListedEstablishment = {
  company_number?: unknown;
  company_status?: unknown;
};

/** What Companies House lists under an overseas company comes to: its one open establishment, none open, or several. */
export type EstablishmentChoice =
  | { kind: 'one'; establishmentNumber: string }
  | { kind: 'none' }
  | { kind: 'several' };

/** The profile fields the link is read from. */
export type LinkedProfile = {
  type?: unknown;
  company_status?: unknown;
  branch_company_details?: unknown;
};

/** What following the link from a matched overseas company came to: its one open establishment taken, none open, several open, or one listed that its own profile does not bear out. */
export type EstablishmentLink = 'followed' | 'none' | 'several' | 'unconfirmed';

/** The overseas company a sponsor's name matched, what following its link came to, and every establishment the register lists under it, open or not. */
export type OverseasMatch = {
  companyNumber: string;
  link: EstablishmentLink;
  establishments: readonly string[];
};

/** Whether a value has the shape of a company number. */
export function isCompanyNumber(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_NUMBER_RE.test(value);
}

/** The establishments in Companies House's answer for an overseas company; none for no answer or no `items`, and null when `items` is something other than a list. */
export function listedEstablishments(
  answer: unknown,
): ListedEstablishment[] | null {
  const items = (answer as { items?: unknown } | null | undefined)?.items;
  if (items === undefined || items === null) return [];
  return Array.isArray(items) ? (items as ListedEstablishment[]) : null;
}

/** The company numbers of the establishments listed, open or not. */
export function establishmentNumbers(
  items: readonly ListedEstablishment[],
): string[] {
  return items.map((item) => item.company_number).filter(isCompanyNumber);
}

/** Whether the register types a profile as an overseas company; its number's prefix does not say. */
export function isOverseasCompany(profile: { type?: unknown }): boolean {
  return profile.type === 'oversea-company';
}

/** What the establishments listed under an overseas company come to. */
export function chooseEstablishment(
  items: readonly ListedEstablishment[],
): EstablishmentChoice {
  const open = items.filter((item) => item.company_status === 'open');
  if (open.length > 1) return { kind: 'several' };
  const establishmentNumber = open[0]?.company_number;
  return isCompanyNumber(establishmentNumber)
    ? { kind: 'one', establishmentNumber }
    : { kind: 'none' };
}

/** Whether a profile is the open UK establishment of the given overseas company, by the register's own link. */
export function isOpenEstablishmentOf(
  profile: LinkedProfile,
  companyNumber: string,
): boolean {
  const branch = profile.branch_company_details as
    | { parent_company_number?: unknown }
    | null
    | undefined;
  return (
    profile.type === 'uk-establishment' &&
    profile.company_status === 'open' &&
    branch?.parent_company_number === companyNumber
  );
}
