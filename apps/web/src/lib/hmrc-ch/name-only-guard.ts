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
  /\b(?:LIMITED|LTD|L\.T\.D|LLP|L\.L\.P|LIMITED\s+LIABILITY\s+PARTNERSHIP|LIMITED\s+PARTNERSHIP|PLC|P\.L\.C|PUBLIC\s+LIMITED\s+COMPANY|CIC|C\.I\.C|COMMUNITY\s+INTEREST\s+COMPANY|CYF|CYFYNGEDIG|CCC|UNLIMITED|LP)[.,\s]*\)?[.,\s]*$/i;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALNUM_RUN = /[^A-Z0-9]+/g;
/** A place shorter than this must be a whole address line to count there. */
const MIN_PLACE_LENGTH = 3;

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

/** The comma-separated pieces of the given fields, each as phrase text. */
function pieces(fields: readonly (string | null | undefined)[]): string[] {
  return fields
    .flatMap((field) => (field ?? '').split(','))
    .map(phraseText)
    .filter((piece) => piece.trim() !== '');
}

/** An office as the place check reads it. */
type Office = {
  /** The places its locality and region hold. */
  places: readonly string[];
  /** Its free-text lines, each whole. */
  lines: readonly string[];
};

/**
 * Whether the office names the place. The locality or region must be the
 * place itself ("Old Stratford" is not Stratford); an address line may end
 * with it, where a town sits, so one that only begins a line names a street
 * ("London Road") or another town ("Newport Pagnell").
 */
function officeNamesPlace(office: Office, place: string): boolean {
  if (office.places.includes(place)) return true;
  return office.lines.some(
    (line) =>
      line === place ||
      (place.length - 2 >= MIN_PLACE_LENGTH && line.endsWith(place)),
  );
}

/** Whether the office names any place in a register field. */
function namesPlace(office: Office, field: string | null | undefined): boolean {
  return pieces([field]).some((place) => officeNamesPlace(office, place));
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
  const office: Office = {
    places: pieces([locality, region]),
    lines: [premises, address_line_1, address_line_2]
      .filter((line): line is string => Boolean(line))
      .map(phraseText),
  };
  if (namesPlace(office, match.townCity)) return false;
  // A county is a wide net: it only supports a company that is still active.
  return !(
    match.companyStatus === 'active' && namesPlace(office, match.county)
  );
}
