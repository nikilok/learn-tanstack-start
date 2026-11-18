/**
 * The place check on a match made on the name alone. Pure, no I/O.
 */

/** The methods that accept a company on its name alone. */
export const NAME_ONLY_METHODS: ReadonlySet<string> = new Set([
  'exact',
  'exact_squash',
  'previous_name',
  'token_sim',
]);

const SUFFIX_END =
  /\b(?:LIMITED|LTD|L\.T\.D|LLP|L\.L\.P|LIMITED\s+LIABILITY\s+PARTNERSHIP|PLC|P\.L\.C|PUBLIC\s+LIMITED\s+COMPANY|CIC|C\.I\.C|COMMUNITY\s+INTEREST\s+COMPANY|CYF|CYFYNGEDIG|CCC|UNLIMITED|LP)[.,\s]*\)?[.,\s]*$/i;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALNUM_RUN = /[^A-Z0-9]+/g;
const MIN_PLACE_LENGTH = 3;
/** Words that make the name before them a street's. */
const STREET_WORDS: ReadonlySet<string> = new Set([
  'ROAD',
  'RD',
  'STREET',
  'LANE',
  'AVENUE',
  'WAY',
  'DRIVE',
  'CLOSE',
  'SQUARE',
  'PLACE',
  'CRESCENT',
  'TERRACE',
  'GROVE',
  'GARDENS',
  'ROW',
  'WALK',
]);

/** A registered office as Companies House returns it. */
export type RegisteredOffice = {
  premises?: string;
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
};

/** A match as the matcher is about to accept it. */
export type NameOnlyMatch = {
  /** The register's legal name, as parsed. */
  legalName: string;
  /** The company number the register name itself carries, if any. */
  registerNumber: string | null | undefined;
  matchMethod: string;
  companyNumber: string;
  companyName: string;
  companyStatus: string | null | undefined;
  office: RegisteredOffice | null | undefined;
  townCity: string | null | undefined;
  county: string | null | undefined;
};

/** Uppercase letters and digits, single-spaced and padded, so a phrase is only found whole. */
function phraseText(value: string): string {
  const folded = value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toUpperCase()
    .replace(NON_ALNUM_RUN, ' ')
    .trim();
  return ` ${folded} `;
}

/** Whether a part of the office names the place, other than as a street's name ("London Road"). */
function partNamesPlace(part: string, place: string): boolean {
  let at = part.indexOf(place);
  while (at >= 0) {
    const next = part.slice(at + place.length).split(' ', 1)[0];
    if (!STREET_WORDS.has(next)) return true;
    at = part.indexOf(place, at + 1);
  }
  return false;
}

/** Whether any place in a register field is named whole within one part of the office. */
function namesPlace(
  office: readonly string[],
  field: string | null | undefined,
): boolean {
  return (field ?? '')
    .split(',')
    .map(phraseText)
    .some(
      (place) =>
        place.length - 2 >= MIN_PLACE_LENGTH &&
        office.some((part) => partNamesPlace(part, place)),
    );
}

/** Whether a match made on the name alone has nothing of the sponsor's place behind it, and so waits for review. */
export function isUnsupportedNameOnlyMatch(match: NameOnlyMatch): boolean {
  if (!NAME_ONLY_METHODS.has(match.matchMethod)) return false;
  // A register name that carries the company's number, or its own suffix, names the legal entity.
  if (match.registerNumber && match.registerNumber === match.companyNumber) {
    return false;
  }
  if (SUFFIX_END.test(match.legalName)) return false;
  if (!SUFFIX_END.test(match.companyName)) return false;

  const { premises, address_line_1, address_line_2, locality, region } =
    match.office ?? {};
  // Each part apart, so a place is never pieced together across two of them.
  const office = [premises, address_line_1, address_line_2, locality, region]
    .filter((part): part is string => Boolean(part))
    .map(phraseText);
  if (namesPlace(office, match.townCity)) return false;
  // A county is a wide net: it only supports a company that is still active.
  return !(
    match.companyStatus === 'active' && namesPlace(office, match.county)
  );
}
