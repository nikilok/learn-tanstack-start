import { describe, expect, test } from 'bun:test';

import { isListingEntry, NEAR_POSTCODE } from './listing-entry';

// A feed supplier trading under its register name, at its registered postcode.
const names = {
  companyName: 'QX AGRI LIMITED',
  sponsorNames: ['QX Agri Ltd t/a Elmbank Nutrition'],
};
const postcode = 'SO22 5AZ';
const conference = 'www.poultry-conference.co.uk';

/** A conference's exhibitor list: each entry an address and the exhibitor's own site. */
const exhibitors = (entry: string) =>
  [
    'EPIC Poultry Conference 2026',
    'Exhibitors',
    'Beta Feeds Ltd, Mill Lane, Ashbourne DE6 1HA',
    'W: betafeeds.co.uk',
    entry,
    'Gamma Hatcheries, Rugeley WS15 1RD',
    'W: gammahatch.eu',
  ].join('\n');

describe('isListingEntry', () => {
  test('an exhibitor list giving the company its own website beside its postcode', () => {
    const page = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nT: 01962 000000 E: sales@elmbanknutrition.co.uk',
    );
    expect(isListingEntry(conference, page, postcode, names)).toBe(true);
    // A written domain, not only an email address.
    const written = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: www.elmbanknutrition.co.uk',
    );
    expect(isListingEntry(conference, written, postcode, names)).toBe(true);
  });

  test("the company's own site may give its other domains, and a host that names it is its own", () => {
    // A brand site whose email is on the legal name's domain: one address.
    const brand =
      'Our homes. Elmbank Nutrition, Unit 4, Winchester SO22 5AZ. Email: info@elmbanknutrition.co.uk';
    expect(
      isListingEntry('www.feeds-example.co.uk', brand, postcode, names),
    ).toBe(false);
    const page = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: elmbanknutrition.com',
    );
    expect(
      isListingEntry('www.elmbanknutrition.co.uk', page, postcode, names),
    ).toBe(false);
  });

  test("a chain's branch list names no other site for the company", () => {
    const branches = [
      'Our nurseries',
      'Ashbourne DE6 1HA',
      'Rugeley WS15 1RD',
      'Elmbank Nutrition, Winchester SO22 5AZ',
      'Book a visit online.',
    ].join('\n');
    expect(isListingEntry(conference, branches, postcode, names)).toBe(false);
  });

  test('its own address in the header, footer and contact block is one address', () => {
    const own = [
      'Elmbank Nutrition, Winchester SO22 5AZ',
      'Visit us: Unit 4, SO22 5AZ',
      'Elmbank Nutrition SO22 5AZ. Email: info@elmbanknutrition.co.uk',
    ].join('\n');
    expect(
      isListingEntry('www.feeds-example.co.uk', own, postcode, names),
    ).toBe(false);
  });

  test('blank lines between an entry and its site count as one break', () => {
    // A page's nested blocks leave runs of empty lines in its visible text.
    const page = exhibitors(
      `Elmbank Nutrition, Unit 4, Winchester SO22 5AZ${'\n \n'.repeat(120)}W: elmbanknutrition.co.uk`,
    );
    expect(isListingEntry(conference, page, postcode, names)).toBe(true);
  });

  test('two addresses are not yet a listing', () => {
    const page = [
      'Beta Feeds Ltd, Mill Lane, Ashbourne DE6 1HA',
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ',
      'W: elmbanknutrition.co.uk',
    ].join('\n');
    expect(isListingEntry(conference, page, postcode, names)).toBe(false);
  });

  test("the site must sit beside the company's own postcode", () => {
    const filler = 'x'.repeat(NEAR_POSTCODE + 20);
    const page = exhibitors(
      `Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\n${filler}\nW: elmbanknutrition.co.uk`,
    );
    expect(isListingEntry(conference, page, postcode, names)).toBe(false);
  });

  test('only a site naming the company, at the domain it is registered under', () => {
    // Another exhibitor's site, the listing's own pages, and a shop platform.
    const others = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: betafeeds.co.uk events.poultry-conference.co.uk elmbank-nutrition.myshopify.com',
    );
    expect(isListingEntry(conference, others, postcode, names)).toBe(false);
  });

  test('a page without the postcode, or a postcode that is not UK, lists nothing for it', () => {
    const page = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: elmbanknutrition.co.uk',
    );
    expect(isListingEntry(conference, page, 'BN1 1AA', names)).toBe(false);
    expect(isListingEntry(conference, page, '92400', names)).toBe(false);
  });
});
