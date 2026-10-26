/**
 * The company's exact registered name with its own legal form, as one phrase
 * on a page: the name arm of the two-signal rule (name-and-place.ts). No I/O.
 */

/** Legal forms a registered name may end in, each with the spellings a page may use. */
const FORMS = new Map([
  ['LIMITED', '(?:LIMITED|LTD)'],
  ['LTD', '(?:LIMITED|LTD)'],
  ['PLC', '(?:PLC|PUBLIC LIMITED COMPANY)'],
  ['LLP', '(?:LLP|LIMITED LIABILITY PARTNERSHIP)'],
  ['CIC', '(?:CIC|C\\.I\\.C|COMMUNITY INTEREST COMPANY)'],
]);

/** What a page may put between a name's words. */
const BETWEEN = "[ .,'’&/\\-]{0,3}";

/** The registered name as a page pattern, every word kept; null without a legal form or a word before it. */
export function exactLegalPattern(companyName: string): RegExp | null {
  const name = companyName
    .toUpperCase()
    .replace(/\(THE\)\s*$/, '')
    .replace(/^THE\s+/, '')
    .trim();
  const words = name
    .replace(/&/g, ' AND ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const form = FORMS.get(words.at(-1) ?? '');
  if (!form || words.length < 2) return null;
  const body = words
    .slice(0, -1)
    .map((word) => (word === 'AND' ? '(?:AND|&)' : word))
    .join(BETWEEN);
  // Never inside a URL, handle or domain: /AcmeLtd and @acmeltd are not the name.
  return new RegExp(
    `(?<![A-Z0-9/@._-])(?:THE )?${body}[ .,'’&-]{1,3}${form}(?![A-Z0-9])`,
  );
}

/** Whether a page's text carries the exact registered name, closed by its legal form. */
export function pageHasExactLegalName(
  text: string,
  companyName: string,
): boolean {
  const pattern = exactLegalPattern(companyName);
  return (
    pattern !== null && pattern.test(text.toUpperCase().replace(/\s+/g, ' '))
  );
}
