/**
 * A company's officers as Companies House lists them, and whether a page
 * names one: the officer arm of the two-signal rule (name-and-place.ts). No
 * I/O; names are matched, never stored.
 */

/** An officer named as a company rather than a person: a corporate director or secretary. */
const CORPORATE =
  /\b(LIMITED|LTD|LLP|PLC|INC|LLC|GMBH|S\.?A\.?|B\.?V\.?|AG|SRL|CORPORATION|COMPANY)\b\.?\s*$/;

/** One person on the officers list. */
export type Officer = {
  forename: string;
  /** Every word of it, as Companies House writes it before the comma. */
  surname: string;
  /** Not resigned. */
  current: boolean;
};

/** A company's officers, or why not: Companies House failed for it, or the run had stopped asking. */
export type OfficerLookup = Officer[] | 'failed' | 'stopped';

/** A name's words as pages are matched: letters, apostrophes and hyphens, upper-cased. */
function nameWords(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/[^A-Z' -]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The people on an officers API response ("SURNAME, Forename Middle"); corporate officers and malformed names left out. */
export function officersOf(response: unknown): Officer[] {
  const items = (response as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const officers: Officer[] = [];
  for (const item of items) {
    const entry = (item ?? {}) as { name?: unknown; resigned_on?: unknown };
    const name = String(entry.name ?? '').trim();
    if (!name || CORPORATE.test(name.toUpperCase())) continue;
    const [surnamePart, rest = ''] = name.split(',');
    const forename = nameWords(rest)[0];
    const surname = nameWords(surnamePart).join(' ');
    if (!forename || forename.length < 2 || surname.length < 2) continue;
    officers.push({ forename, surname, current: !entry.resigned_on });
  }
  return officers;
}

/** Whether the text names one of the officers: forename, up to two middle names or initials, surname. */
export function officerNamedIn(
  text: string,
  officers: readonly Officer[],
): boolean {
  const page = ` ${text
    .toUpperCase()
    .replace(/[^A-Z0-9' -]/g, ' ')
    .replace(/\s+/g, ' ')} `;
  return officers.some((officer) =>
    new RegExp(
      `(?<![A-Z])${officer.forename}(?: [A-Z]\\.?| [A-Z]{2,}){0,2} ${officer.surname}(?![A-Z])`,
    ).test(page),
  );
}
