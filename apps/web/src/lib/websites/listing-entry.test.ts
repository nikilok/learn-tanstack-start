import { describe, expect, test } from 'bun:test';

import { isListingEntry, NEAR_POSTCODE } from './listing-entry';

// A feed supplier trading under its register name, at its registered postcode.
const names = {
  companyName: 'QX AGRI LIMITED',
  sponsorNames: ['QX Agri Ltd t/a Elmbank Nutrition'],
};
const postcode = 'SO22 5AZ';
const conference = 'www.poultry-conference.co.uk';
const brandHost = 'www.feeds-example.co.uk';

/** Other exhibitors, each with an address and its own site. */
const OTHERS = [
  ['Beta Feeds Ltd, Mill Lane, Ashbourne DE6 1HA', 'betafeeds.co.uk'],
  ['Gamma Hatcheries, Rugeley WS15 1RD', 'gammahatch.eu'],
  ['Delta Grain, Market Rasen LN8 3AA', 'deltagrain.com'],
  ['Epsilon Eggs, Driffield YO25 6AB', 'epsiloneggs.co.uk'],
  ['Zeta Vets, Malton YO17 7AB', 'zetavets.org.uk'],
];

/** A conference's exhibitor list: the company's entry after the first two of `count` others. */
const exhibitors = (entry: string, count = OTHERS.length) => {
  const others = OTHERS.slice(0, count).map(
    ([address, site]) => `${address}\nW: ${site}`,
  );
  return [
    'EPIC Poultry Conference 2026',
    'Exhibitors',
    ...others.slice(0, 2),
    entry,
    ...others.slice(2),
  ].join('\n');
};

/** The company's own entry, giving its own site. */
const entry =
  'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: elmbanknutrition.co.uk';

/** Four exhibitors that each give their own site, one short of a listing, and the entries under test. */
const oneShort = (...lines: string[]) =>
  exhibitors([entry, ...lines].join('\n'), 4);

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

  test('a site under any top-level domain, written or as an email', () => {
    for (const site of [
      'W: elmbanknutrition.dev',
      'E: hello@elmbanknutrition.london',
      'W: www.elmbanknutrition.uk.com',
    ]) {
      const page = exhibitors(
        `Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\n${site}`,
      );
      expect(isListingEntry(conference, page, postcode, names)).toBe(true);
    }
  });

  test('five other businesses giving their own sites make a listing, and four do not', () => {
    expect(
      isListingEntry(conference, exhibitors(entry, 5), postcode, names),
    ).toBe(true);
    expect(
      isListingEntry(conference, exhibitors(entry, 4), postcode, names),
    ).toBe(false);
  });

  test("a company's own privacy page cites its regulators with their addresses and sites", () => {
    // A brand site: its controller's address with a legal-name email, then the bodies it answers to.
    const privacy = [
      'Privacy policy',
      'Elmbank Nutrition is a trading name of QX Agri Ltd, Unit 4, Winchester SO22 5AZ, the data controller.',
      'Contact our data protection lead at privacy@elmbanknutrition.co.uk.',
      "You may complain to the Information Commissioner's Office, Wycliffe House, Water Lane, Wilmslow SK9 5AF. Website: ico.org.uk",
      'Or to the Financial Ombudsman Service, Exchange Tower, London E14 9SR. Website: www.financial-ombudsman.org.uk',
      'We are authorised by the Financial Conduct Authority, 12 Endeavour Square, London E20 1JN. www.fca.org.uk',
      'and the Prudential Regulation Authority, 20 Moorgate, London EC2R 6DA. www.bankofengland.co.uk',
    ].join('\n');
    expect(isListingEntry(brandHost, privacy, postcode, names)).toBe(false);
  });

  test("the company's own site may give its other domains, and a host that names it is its own", () => {
    // A brand site whose email is on the legal name's domain: one address.
    const brand =
      'Our homes. Elmbank Nutrition, Unit 4, Winchester SO22 5AZ. Email: info@elmbanknutrition.co.uk';
    expect(isListingEntry(brandHost, brand, postcode, names)).toBe(false);
    const page = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: elmbanknutrition.com',
    );
    expect(
      isListingEntry('www.elmbanknutrition.co.uk', page, postcode, names),
    ).toBe(false);
  });

  test("a brand site's branches and its legal-name email are one business", () => {
    const branches = OTHERS.map(([address]) => address.split(', ').at(-1));
    const own =
      'Elmbank Nutrition, Winchester SO22 5AZ. Email: info@elmbanknutrition.co.uk';
    // Its host spells the brand, not the registered name; no branch is given a site.
    const brand = ['Our homes', ...branches, own].join('\n');
    expect(isListingEntry(brandHost, brand, postcode, names)).toBe(false);
    // A regulator's site beside every branch is one site, not other businesses,
    // and a body the company belongs to is written beside the company's own address.
    const rated = [
      ...branches.map((branch) => `${branch}. Rated: cqc.org.uk`),
      'Elmbank Nutrition, Winchester SO22 5AZ. Member: feedassoc.org.uk. Email: info@elmbanknutrition.co.uk',
    ].join('\n');
    expect(isListingEntry(brandHost, rated, postcode, names)).toBe(false);
    // A what3words address is no site.
    const words = [
      'filled.count.soap',
      'index.home.raft',
      'grape.lion.tent',
      'stone.river.coat',
      'mint.pause.lamp',
    ];
    const located = [
      ...branches.map((branch, i) => `${branch}, ///${words[i]}`),
      own,
    ].join('\n');
    expect(isListingEntry(brandHost, located, postcode, names)).toBe(false);
  });

  test('a listing gives other businesses their own sites, beside their own postcodes', () => {
    // The other entries give no sites.
    const bare = [
      ...OTHERS.map(([address]) => address),
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: elmbanknutrition.co.uk',
    ].join('\n');
    expect(isListingEntry(conference, bare, postcode, names)).toBe(false);
    // Personal emails at one mail provider: no site of their own.
    const shared = oneShort(
      'Zeta Vets, Malton YO17 7AB. E: jo@mailhost.com',
      'Eta Farms, Thirsk YO7 1AA. E: sam@mailhost.com',
    );
    expect(isListingEntry(conference, shared, postcode, names)).toBe(false);
    // A dotted name is no site, however many parts it has.
    for (const email of [
      'john.smith.jr@gmail.com',
      'jane.mary.doe @gmail.com',
    ]) {
      const dotted = oneShort(`Zeta Vets, Malton YO17 7AB. E: ${email}`);
      expect(isListingEntry(conference, dotted, postcode, names)).toBe(false);
    }
    // Mail providers and social networks are no business's own site, one each or not.
    for (const [zeta, eta] of [
      ['E: zeta.vets@gmail.com', 'E: eta@outlook.com'],
      ['facebook.com/zetavets', 'instagram.com/etafarms'],
    ]) {
      const platforms = oneShort(
        `Zeta Vets, Malton YO17 7AB. ${zeta}`,
        `Eta Farms, Thirsk YO7 1AA. ${eta}`,
      );
      expect(isListingEntry(conference, platforms, postcode, names)).toBe(
        false,
      );
    }
    // One other business giving two sites is still one business.
    const twoSites = exhibitors(entry, 4).replace(
      'W: betafeeds.co.uk',
      'W: betafeeds.co.uk, betagroup.com',
    );
    expect(isListingEntry(conference, twoSites, postcode, names)).toBe(false);
    // The listing's own pages are not other businesses.
    const own = oneShort(
      'Zeta Vets, Malton YO17 7AB. Stand: poultry-conference.co.uk/z',
    );
    expect(isListingEntry(conference, own, postcode, names)).toBe(false);
  });

  test("a chain's branch list names no other site for the company", () => {
    const branches = [
      'Our nurseries',
      ...OTHERS.map(([address]) => address.split(', ').at(-1)),
      'Elmbank Nutrition, Winchester SO22 5AZ',
      'Book a visit online.',
    ].join('\n');
    expect(isListingEntry(conference, branches, postcode, names)).toBe(false);
  });

  test('its own address in the header, footer and contact block is one address', () => {
    // Beside partners that each give a site: one address short of a listing in all.
    const own = [
      'Elmbank Nutrition, Winchester SO22 5AZ',
      'Visit us: Unit 4, SO22 5AZ',
      'Elmbank Nutrition SO22 5AZ. Email: info@elmbanknutrition.co.uk',
      ...OTHERS.slice(0, 4).map(
        ([address, site]) => `Partner: ${address}. ${site}`,
      ),
    ].join('\n');
    expect(isListingEntry(brandHost, own, postcode, names)).toBe(false);
  });

  test('a site written before its postcode, and nearest it, is beside it too', () => {
    const page = exhibitors(
      'Elmbank Nutrition, elmbanknutrition.co.uk, SO22 5AZ',
    );
    expect(isListingEntry(conference, page, postcode, names)).toBe(true);
  });

  test('blank lines between an entry and its site count as one break', () => {
    // A page's nested blocks leave runs of empty lines in its visible text.
    const page = exhibitors(
      `Elmbank Nutrition, Unit 4, Winchester SO22 5AZ${'\n \n'.repeat(120)}W: elmbanknutrition.co.uk`,
    );
    expect(isListingEntry(conference, page, postcode, names)).toBe(true);
  });

  test("the site must sit beside the company's own postcode", () => {
    const filler = 'x'.repeat(NEAR_POSTCODE + 20);
    // Nearer another exhibitor's postcode than the company's.
    const page = exhibitors(
      `Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\n${filler}\nW: elmbanknutrition.co.uk`,
    );
    expect(isListingEntry(conference, page, postcode, names)).toBe(false);
    // Nearest the company's postcode, but too far from it.
    const last = `${exhibitors('')}\nElmbank Nutrition, Unit 4, Winchester SO22 5AZ\n${filler}\nW: elmbanknutrition.co.uk`;
    expect(isListingEntry(conference, last, postcode, names)).toBe(false);
  });

  test('only a site naming the company, at the domain it is registered under', () => {
    // Another exhibitor's site, and the listing's own pages.
    const others = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: betafeeds.co.uk events.poultry-conference.co.uk',
    );
    expect(isListingEntry(conference, others, postcode, names)).toBe(false);
    // A shop platform's subdomain is the platform's.
    const shop = exhibitors(
      'Elmbank Nutrition, Unit 4, Winchester SO22 5AZ\nW: elmbank-nutrition.myshopify.com',
    );
    expect(isListingEntry(conference, shop, postcode, names)).toBe(false);
  });

  test('a page without the postcode, or a postcode that is not UK, lists nothing for it', () => {
    const page = exhibitors(entry);
    expect(isListingEntry(conference, page, 'BN1 1AA', names)).toBe(false);
    expect(isListingEntry(conference, page, '92400', names)).toBe(false);
  });
});
