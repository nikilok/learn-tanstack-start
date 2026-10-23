/**
 * Statutory company numbers a page states, whoever they belong to. No I/O.
 *
 * Only numbers in statutory wording count ("company number", "registered in
 * England and Wales No.", "Acme Limited (01234567)"), so a listing that prints
 * "Companies House number" beside other companies' names is not read as the
 * site naming itself.
 */

import { crowdKey } from './crowded-hosts';
import { pageHasCompanyNumber, visibleText } from './extract';

/** Companies House register prefixes a number may carry. */
const PREFIX =
  '(?:SC|NI|OC|SO|NC|R0|IP|SP|RS|LP|SL|SF|NL|NF|NP|NR|FC|GE|CE|BR|CS|ZC|OE|RC|AC)';
/** A number in digit groups; refused where another group follows on its line, after a space or a mark, as a phone number's does. */
const GROUPED = `(?:${PREFIX}\\s?\\d{3}\\s\\d{3}|\\d{1,2}\\s\\d{3}\\s\\d{3}|\\d{3}\\s\\d{3}\\s\\d{2}|\\d{4}\\s\\d{4}|\\d{3}\\s\\d{4})(?![^\\S\\n]\\d|[^\\d\\s]\\d)`;
/** A number as sites write it: prefixed, padded or not, or in digit groups. */
const NUMBER = `(${PREFIX}\\s?\\d{6}|${GROUPED}|\\d{6,8})`;
/** Only the full forms, where the wording around them is looser. */
const FULL = `(${PREFIX}\\s?\\d{6}|\\d{8})`;
const PLACE =
  '(?:england(?:\\s*(?:&|and)\\s*wales)?|wales|scotland|northern\\s+ireland|the\\s+uk|the\\s+united\\s+kingdom|uk)';
const SUFFIX = '(?:limited|ltd|llp|plc|cic)';

/** Statutory lead-ins that end where the number starts. */
const LEADS = [
  `company\\s+(?:registration\\s+|reg(?:istration)?\\.?\\s+|registered\\s+)?(?:no|number|num|nr)\\b\\.?`,
  `company\\s+reg(?:istration)?\\b\\.?`,
  `company\\s*\\(\\s*(?:no|number)\\b\\.?`,
  `\\bco\\.?\\s*(?:reg(?:istration)?\\.?\\s*)?(?:no|number)\\b\\.?`,
  `registered\\s+(?:company\\s+)?(?:no|number|num)\\b\\.?`,
  `registered\\s+in\\s+${PLACE}\\b[^.\\n]{0,50}?(?:no|number|num)\\b\\.?`,
  `registered\\s+in\\s+${PLACE}\\b\\s*(?:under|with)?\\s*[:,(\\-–]?`,
  `reg(?:istration)?\\.?\\s+(?:no|number)\\b\\.?`,
];

const PATTERNS = [
  new RegExp(
    `(?:${LEADS.join('|')})\\s*(?:is\\s+)?[:.#\\-–]?\\s*${NUMBER}(?![0-9A-Z])`,
    'gi',
  ),
  // "a public company SC610054"
  new RegExp(`\\bcompany\\s+(${PREFIX}\\s?\\d{6})(?![0-9A-Z])`, 'gi'),
  // "Acme Limited (09910619)"
  new RegExp(
    `\\b${SUFFIX}\\b\\.?\\s*\\(\\s*(?:company\\s+)?(?:(?:no|number|reg(?:istration)?)\\.?\\s*)?(${PREFIX}\\s?\\d{6}|\\d{7,8})\\s*\\)`,
    'gi',
  ),
  // "11252565 (Acme Mobile Limited)"
  new RegExp(
    `(?<![0-9A-Z])${FULL}\\s*\\(\\s*[^()\\n]{2,80}?\\b${SUFFIX}\\b\\.?\\s*\\)`,
    'gi',
  ),
  // "Acme Global Limited 02884211"
  new RegExp(`\\b${SUFFIX}\\b\\.?,?\\s+${FULL}(?![0-9A-Z])`, 'gi'),
];

/** Registers a number can belong to; any but `company` is not Companies House's. */
const REGISTER =
  /\b(company|vat|charity|charities|fca|frn|ico|data\s+protection|gmc|cqc|ofsted|urn|osr|fsa|sra|nmc|hcpc|gdc|gphc)\b/gi;

/** A phone line's label right before a number ("Tel No.", "Fax:"); an earlier one labels its own digits. */
const PHONE_LABEL =
  /\b(?:tel|telephone|phone|fax|mobile)\b\.?\s*(?:(?:no|number|nr)\b\.?)?\s*[:#\-–]?\s*$/i;

/** Whether a number's own label, in its clause, is a phone line's or another register's. */
export function namesOtherRegister(wordingBefore: string): boolean {
  // "No." and "Reg." end abbreviations, not clauses.
  const flat = wordingBefore.replace(
    /\b(no|nr|num|reg|co|ltd|plc|inc)\./gi,
    '$1',
  );
  const clause = flat.slice(
    Math.max(...['.', '\n', '|', ';'].map((c) => flat.lastIndexOf(c))) + 1,
  );
  if (PHONE_LABEL.test(clause)) return true;
  const named = [...clause.matchAll(REGISTER)].at(-1)?.[1];
  return !!named && named.toLowerCase() !== 'company';
}

/** Most numbers a page may state and still be read; past it the page is a listing. A group's own page can list dozens. */
export const MAX_STATED_PER_PAGE = 100;

/** Wording kept around a number as its evidence. */
const CONTEXT_BEFORE = 100;
const CONTEXT_AFTER = 40;

export type StatedNumber = {
  /** Companies House form: eight characters, numeric ones zero-padded. */
  companyNumber: string;
  /** The statutory wording the number was read in. */
  context: string;
};

/** A stated number in Companies House's eight-character form, or null. */
export function normaliseStatedNumber(raw: string): string | null {
  let number = raw.replace(/\s+/g, '').toUpperCase();
  if (/^\d+$/.test(number)) {
    if (number.length < 6) return null;
    number = number.padStart(8, '0');
  }
  // R0 is the one register prefix with a digit in it.
  if (
    !/^(?:[A-Z]{2}\d{6}|R0\d{6}|\d{8})$/.test(number) ||
    /^0+$/.test(number)
  ) {
    return null;
  }
  return number;
}

/** Statutory company numbers stated in a page's visible text, first wording kept. */
export function statedCompanyNumbers(html: string): StatedNumber[] {
  const text = visibleText(html);
  const found = new Map<string, string>();
  const matches = PATTERNS.flatMap((pattern) => [
    ...text.matchAll(pattern),
  ]).sort((a, b) => a.index - b.index);
  for (const match of matches) {
    // The wording up to the number, lead-in included: "Registered in England
    // and Wales, Charity No." names its register inside the match.
    const numberAt = match.index + match[0].lastIndexOf(match[1]);
    const before = text.slice(Math.max(0, match.index - 40), numberAt);
    if (namesOtherRegister(before)) continue;
    const companyNumber = normaliseStatedNumber(match[1]);
    if (!companyNumber || found.has(companyNumber)) continue;
    const end = match.index + match[0].length + CONTEXT_AFTER;
    const context = text
      .slice(Math.max(0, match.index - CONTEXT_BEFORE), end)
      .replace(/\s+/g, ' ')
      .trim();
    found.set(companyNumber, context);
    if (found.size > MAX_STATED_PER_PAGE) return [];
  }
  return [...found].map(([companyNumber, context]) => ({
    companyNumber,
    context,
  }));
}

/** Whether a page carries this company's number: one token anywhere, or stated in statutory wording, digit groups and dropped zeros included. `stated` reuses numbers already read off the page. */
export function pageShowsCompanyNumber(
  html: string,
  companyNumber: string,
  stated?: readonly StatedNumber[],
): boolean {
  if (pageHasCompanyNumber(html, companyNumber)) return true;
  const own = normaliseStatedNumber(companyNumber);
  return (
    own !== null &&
    (stated ?? statedCompanyNumbers(html)).some((s) => s.companyNumber === own)
  );
}

/** A stated number tied to the site and page it was read on. */
export type StatedOnSite = StatedNumber & {
  /** crowdKey form of the page's host. */
  host: string;
  pageUrl: string;
};

/** One entry per site and number, first wording kept: an upsert may not touch a key twice. */
export function dedupeStated(entries: readonly StatedOnSite[]): StatedOnSite[] {
  const seen = new Map<string, StatedOnSite>();
  for (const entry of entries) {
    const key = `${entry.host}|${entry.companyNumber}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

/** Numbers a fetched page states, keyed to the host the page was served from. */
export function statedOnPage(pageUrl: string, html: string): StatedOnSite[] {
  let host: string;
  try {
    host = crowdKey(new URL(pageUrl).hostname);
  } catch {
    return [];
  }
  return statedCompanyNumbers(html).map((stated) => ({
    ...stated,
    host,
    pageUrl,
  }));
}
