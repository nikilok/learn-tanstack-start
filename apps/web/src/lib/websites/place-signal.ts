/**
 * Whether a site says it is where the company is: the place half of the
 * two-signal rule (name-and-place.ts). No I/O.
 */

import { POSTCODE_INWARD, POSTCODE_OUTWARD } from './extract';

/** Fewest letters a place name needs to count. */
const MIN_PLACE_LETTERS = 4;

/** Most distinct postcodes read off one page. */
export const MAX_PAGE_POSTCODES = 30;

const POSTCODE = new RegExp(
  `\\b(${POSTCODE_OUTWARD})\\s*(${POSTCODE_INWARD})\\b`,
  'g',
);

/** The company's places as whole-word phrases: its sponsor-register towns and registered office locality. */
export function placePhrases(
  towns: readonly (string | null)[],
  locality: string | null,
): string[] {
  const phrases = new Set<string>();
  for (const place of [...towns, locality]) {
    if (!place) continue;
    const phrase = place
      .toUpperCase()
      .replace(/[^A-Z]+/g, ' ')
      .trim();
    if (phrase.replace(/ /g, '').length >= MIN_PLACE_LETTERS) {
      phrases.add(phrase);
    }
  }
  return [...phrases];
}

/** Whether the text names one of the places as whole words: Ware is not in software. */
export function textNamesPlace(
  text: string,
  phrases: readonly string[],
): boolean {
  const words = ` ${text.toUpperCase().replace(/[^A-Z]+/g, ' ')} `;
  return phrases.some((phrase) => words.includes(` ${phrase} `));
}

/** The distinct postcodes a page's text shows, in order, at most MAX_PAGE_POSTCODES. */
export function pagePostcodes(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim().toUpperCase();
  const found = [...flat.matchAll(POSTCODE)].map((m) => `${m[1]} ${m[2]}`);
  return [...new Set(found)].slice(0, MAX_PAGE_POSTCODES);
}

/** A postcode's district, its outward code: SO22 for SO22 5AZ; empty when too short to have one. */
export function postcodeDistrict(postcode: string): string {
  return postcode.toUpperCase().replace(/\s+/g, '').slice(0, -3);
}
