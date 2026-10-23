import { describe, expect, test } from 'bun:test';

import {
  hostIsWholeName,
  hostNamesAny,
  hostNamesCompany,
  nameInitials,
  namesCompany,
  nameWords,
  pageHasWholeName,
  pageNamesCompany,
  registerNames,
  registrableDomain,
} from './company-naming';

describe('nameWords', () => {
  test('keeps the words that say which company it is', () => {
    expect(nameWords('ACME WIDGETS LIMITED')).toEqual(['ACME', 'WIDGETS']);
    expect(nameWords('ASHBY & MOORE LIMITED')).toEqual(['ASHBY', 'MOORE']);
  });

  test('drops legal, generic and one- or two-letter words', () => {
    expect(nameWords('THE ACME ENGINEERING GROUP (UK) LTD')).toEqual(['ACME']);
    expect(nameWords('P.L. BLAKE LIMITED')).toEqual(['BLAKE']);
    expect(nameWords('M&G FA LIMITED')).toEqual([]);
  });
});

describe('nameInitials', () => {
  test('takes every word but the legal ones', () => {
    expect(nameInitials('P.L. BLAKE LIMITED')).toBe('PLB');
    expect(nameInitials('RETAIL COMPUTER SOLUTIONS LIMITED')).toBe('RCS');
    expect(nameInitials('JONES LANG LASALLE SERVICES LIMITED')).toBe('JLLS');
  });
});

describe('hostNamesCompany', () => {
  test('a domain carrying a word of the name', () => {
    expect(
      hostNamesCompany('www.acmewidgets.co.uk', 'ACME WIDGETS LIMITED'),
    ).toBe(true);
    expect(hostNamesCompany('uk.acme.com', 'ACME LIMITED')).toBe(true);
  });

  test('a word only where a label starts with it, not inside another word', () => {
    expect(
      hostNamesCompany('bizengineering.com', 'BIZ ENGINEERING LIMITED'),
    ).toBe(true);
    expect(hostNamesCompany('showbiz.co.uk', 'BIZ ENGINEERING LIMITED')).toBe(
      false,
    );
    expect(hostNamesCompany('primrosedental.co.uk', 'ROSE BAKERY LTD')).toBe(
      false,
    );
  });

  test('a leading THE is read both ways: theplbgroup is PLBGROUP, thermalenergy is not RMALENERGY', () => {
    expect(
      hostNamesCompany('www.thermalenergy.com', 'THERMAL ENERGY (UK) LTD'),
    ).toBe(true);
    expect(hostNamesCompany('www.theacme.co.uk', 'ACME WIDGETS LTD')).toBe(
      true,
    );
  });

  test("a domain made of the name's initials", () => {
    expect(
      hostNamesCompany('www.rcs-uk.com', 'RETAIL COMPUTER SOLUTIONS LIMITED'),
    ).toBe(true);
    expect(
      hostNamesCompany('www.jll.com', 'JONES LANG LASALLE SERVICES LIMITED'),
    ).toBe(true);
    expect(hostNamesCompany('theplbgroup.co.uk', 'P.L. BLAKE LIMITED')).toBe(
      true,
    );
  });

  test("a domain that is the name's opening letters", () => {
    expect(hostNamesCompany('www.mandg.com', 'M&G FA LIMITED')).toBe(true);
  });

  test("another business's domain does not", () => {
    // A contractor listing its on-site office at the company's premises.
    expect(
      hostNamesCompany(
        'www.contractor-logistics.co.uk',
        'ACME WIDGETS LIMITED',
      ),
    ).toBe(false);
    expect(
      hostNamesCompany('www.careservices.co.uk', 'ACME CARE SERVICES LIMITED'),
    ).toBe(false);
  });

  test("a label that is only the name's first word, or the start of it, does not", () => {
    // As often another business's domain: a generic first word especially.
    expect(
      hostNamesCompany('www.london-plumbers.co.uk', 'LONDON CARE LTD'),
    ).toBe(false);
    expect(
      hostNamesCompany('www.london.gov.uk', 'LONDON PROPERTY GROUP LTD'),
    ).toBe(false);
    expect(hostNamesCompany('glo.co.uk', 'GLOBAL LOGISTICS LTD')).toBe(false);
    // Initials that spell the start of the first word are that word.
    expect(
      hostNamesCompany('www.london.co.uk', 'LONDON OFFICE NETWORK LTD'),
    ).toBe(false);
    // A leading THE is not the first word: the initials skip it too.
    expect(
      hostNamesCompany('www.london.co.uk', 'THE LONDON OFFICE NETWORK LTD'),
    ).toBe(false);
    // Nor is THE plus the first word, the name's own opening letters or not.
    expect(
      hostNamesCompany('www.thelondon.co.uk', 'THE LONDON OFFICE NETWORK LTD'),
    ).toBe(false);
    expect(
      hostNamesCompany('theglobal.co.uk', 'THE GLOBAL LOGISTICS LTD'),
    ).toBe(false);
    // Running past the first word, the domain is the name.
    expect(hostNamesCompany('www.londoncare.co.uk', 'LONDON CARE LTD')).toBe(
      true,
    );
  });

  test('the top-level domain is not part of the name', () => {
    expect(hostNamesCompany('www.example.net', 'NET PAYMENTS LIMITED')).toBe(
      false,
    );
  });

  test('a company without a name matches nothing', () => {
    expect(hostNamesCompany('www.acme.co.uk', '')).toBe(false);
  });
});

describe('namesCompany', () => {
  const names = { companyName: 'ACME WIDGETS LIMITED', sponsorNames: [] };

  test('a page whose text names the company, whatever host served it', () => {
    expect(
      namesCompany('contractor.co.uk', 'Acme Widgets Ltd, SO22 5AZ', names),
    ).toBe(true);
  });

  test('a page served from a host carrying the name, whatever it says', () => {
    expect(namesCompany('acmewidgets.co.uk', 'SO22 5AZ', names)).toBe(true);
  });

  test("another business's page names neither way", () => {
    expect(
      namesCompany('contractor.co.uk', 'Our offices: SO22 5AZ', names),
    ).toBe(false);
  });

  // A clinic trading under its sponsor-register name, which never shows the
  // registered one: the shape of the rejections the register's names fix.
  const trading = {
    companyName: 'FENWICK CHIROPRACTIC LTD',
    sponsorNames: ['Fenwick Chiropractic Ltd T/A Elmbank Chiropractic Clinic'],
  };
  const unregistered = { ...trading, sponsorNames: [] };

  test("a site under the sponsor register's trading name, by its host", () => {
    const text = 'Book online. 209 High Road, SO22 5AZ';
    expect(namesCompany('www.elmbankchiropractic.co.uk', text, trading)).toBe(
      true,
    );
    expect(
      namesCompany('www.elmbankchiropractic.co.uk', text, unregistered),
    ).toBe(false);
  });

  test("a site under the sponsor register's trading name, in its text", () => {
    // A host that names nobody, so only the text can.
    const host = 'www.example-bookings.co.uk';
    expect(namesCompany(host, 'Book online. SO22 5AZ', trading)).toBe(false);
    expect(
      namesCompany(
        host,
        'Elmbank Chiropractic Clinic, 209 High Road, SO22 5AZ',
        trading,
      ),
    ).toBe(true);
  });

  test('a trading name never names the company by one of its words or its initials', () => {
    // A neighbour in the same medical centre, and a booking platform.
    const text = 'Unit 2, Medical Centre, SO22 5AZ';
    expect(namesCompany('www.clinic4u.co.uk', text, trading)).toBe(false);
    expect(namesCompany('www.ecclesdental.co.uk', text, trading)).toBe(false);
    expect(namesCompany('www.elmbank.co.uk', text, trading)).toBe(false);
    // One-word trading names are a word anyone may use.
    const premier = {
      companyName: 'HAMPTON STORES LTD',
      sponsorNames: ['Hampton Stores Ltd T/A Premier'],
    };
    expect(
      namesCompany(
        'www.premierdentalcare.co.uk',
        'Premier Dental Care, SO22 5AZ',
        premier,
      ),
    ).toBe(false);
    const home = {
      companyName: 'ACME CAPITAL LTD',
      sponsorNames: ['ACME CAPITAL LTD T/A HOME'],
    };
    expect(
      namesCompany(
        'www.smithsolicitors.co.uk',
        'Home | About | Contact / Smith & Co Solicitors / 12 High Street, SO22 5AZ',
        home,
      ),
    ).toBe(false);
  });

  test('a trading name read off a page only as one phrase', () => {
    const dental = {
      companyName: 'ACME WIDGETS LIMITED',
      sponsorNames: ['Acme Widgets Ltd T/A Elmbank Dental'],
    };
    // Another practice on the same road.
    expect(
      namesCompany(
        'www.smiledental.co.uk',
        'Smile Dental, 12 Elmbank Road, SO22 5AZ',
        dental,
      ),
    ).toBe(false);
    expect(
      namesCompany(
        'www.example.co.uk',
        'Elmbank Dental, 12 High Road, SO22 5AZ',
        dental,
      ),
    ).toBe(true);
  });

  test("the register's legal name read off a page whole, closed by its legal form", () => {
    // The register spells the legal name apart from Companies House.
    const pr = { companyName: 'QXPR LIMITED', sponsorNames: ['QX PR Ltd'] };
    const host = 'www.weareqx.com';
    expect(namesCompany(host, '© Copyright QX PR Ltd, SO22 5AZ', pr)).toBe(
      true,
    );
    expect(namesCompany(host, 'QX PR, The Loft, SO22 5AZ', pr)).toBe(false);
    // Short and generic words, which the register's other rules never read.
    const agency = {
      companyName: 'QX AGENCY LIMITED',
      sponsorNames: ['QX Design Marketing Digital Ltd'],
    };
    expect(
      namesCompany(
        'www.qx.net',
        'Full name of legal entity: QX Design Marketing Digital Ltd. SO22 5AZ',
        agency,
      ),
    ).toBe(true);
    // A trading name is no legal name, whatever follows it.
    const premier = {
      companyName: 'HAMPTON STORES LTD',
      sponsorNames: ['Hampton Stores Ltd T/A Premier'],
    };
    expect(
      namesCompany('www.example.co.uk', 'Premier Ltd, SO22 5AZ', premier),
    ).toBe(false);
  });

  test('a name of short or generic words, by the whole name', () => {
    const shortName = { companyName: 'QX ASSOCIATES LTD', sponsorNames: [] };
    expect(
      hostNamesCompany('www.qx-associates.co.uk', 'QX ASSOCIATES LTD'),
    ).toBe(false);
    expect(namesCompany('www.qx-associates.co.uk', 'SO22 5AZ', shortName)).toBe(
      true,
    );
    expect(
      namesCompany('www.qxassociatesltd.co.uk', 'SO22 5AZ', shortName),
    ).toBe(true);
    expect(
      namesCompany(
        'www.example.co.uk',
        'QX Associates Limited, SO22 5AZ',
        shortName,
      ),
    ).toBe(true);
    // A pretty-printed footer wraps the name across source lines.
    expect(
      namesCompany(
        'www.example.co.uk',
        'Copyright 2024 QX\n    Associates Ltd. Unit 4, SO22 5AZ',
        shortName,
      ),
    ).toBe(true);
  });

  /** namesCompany on a neighbour's page, by the registered name alone. */
  const onPage = (companyName: string, text: string) =>
    namesCompany('www.neighbour.co.uk', text, {
      companyName,
      sponsorNames: [],
    });

  test('a whole name read off a page only as the registered name, closed by its legal form', () => {
    expect(onPage('STAR CARE PLC', 'Welcome to Starcare PLC, SO22 5AZ')).toBe(
      true,
    );
    expect(onPage('STAR CARE PLC', 'Starcare homes, SO22 5AZ')).toBe(false);
    // Prose, abbreviations, compound words and other sites' domains.
    expect(
      onPage('WE CARE (UK) LTD', 'We care about every resident. SO22 5AZ'),
    ).toBe(false);
    expect(
      onPage('WE CARE (UK) LTD', 'We Care (UK) Ltd, Unit 4, SO22 5AZ'),
    ).toBe(true);
    expect(onPage('R & D LTD', 'Our M&E and R&D teams. SO22 5AZ')).toBe(false);
    expect(
      onPage('SUN DAY LTD', 'Open Monday to Saturday, Sunday closed. SO22 5AZ'),
    ).toBe(false);
    expect(
      onPage('ACME WIDGETS LIMITED', 'Clients: acmewidgets.co.uk, SO22 5AZ'),
    ).toBe(false);
  });

  test('a whole name as it is registered: initials, slashes, dashes, a UK or a qualifier', () => {
    expect(
      onPage('J.B. ASSOCIATES LIMITED', 'J.B. Associates Ltd, SO22 5AZ'),
    ).toBe(true);
    expect(onPage('24/7 CARE LTD', '24/7 Care Ltd, SO22 5AZ')).toBe(true);
    expect(
      onPage('I AM ASSOCIATES LIMITED', 'I‑AM Associates Limited, SO22 5AZ'),
    ).toBe(true);
    expect(onPage('JS UK SERVICE LIMITED', 'JS UK Service Ltd, SO22 5AZ')).toBe(
      true,
    );
    expect(
      onPage('3A CARE (LONDON) LTD', '3A Care (London) Ltd, SO22 5AZ'),
    ).toBe(true);
    expect(onPage('3A CARE (LONDON) LTD', '3A Care Ltd, SO22 5AZ')).toBe(true);
  });

  test("the register's names still need the page to carry one", () => {
    expect(
      namesCompany('contractor.co.uk', 'Our offices: SO22 5AZ', {
        ...names,
        sponsorNames: ['Acme Widgets Ltd T/A Acme Dental'],
      }),
    ).toBe(false);
  });
});

describe('hostNamesAny', () => {
  const trading = {
    companyName: 'FENWICK CHIROPRACTIC LTD',
    sponsorNames: ['Fenwick Chiropractic Ltd T/A Elmbank Chiropractic Clinic'],
  };

  test('a host naming the company by its registered name or a register name', () => {
    expect(hostNamesAny('www.fenwickchiro.co.uk', trading)).toBe(true);
    expect(hostNamesAny('elmbankchiropractic.co.uk', trading)).toBe(true);
  });

  test("never another business's host, nor one word of a trading name", () => {
    expect(hostNamesAny('www.example.co.uk', trading)).toBe(false);
    expect(hostNamesAny('www.clinic4u.co.uk', trading)).toBe(false);
  });
});

describe('registrableDomain', () => {
  test('the domain a host is registered under, past any subdomain', () => {
    expect(registrableDomain('shop.acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('www.acme.com')).toBe('acme.com');
    expect(registrableDomain('acme.myshopify.com')).toBe('myshopify.com');
    expect(registrableDomain('Acme.Co.UK.')).toBe('acme.co.uk');
    expect(registrableDomain('acme.com.au')).toBe('acme.com.au');
  });
});

describe('registerNames', () => {
  test('splits an entry at its trading name, in every spelling the register uses', () => {
    expect(
      registerNames('Fenwick Chiropractic Ltd T/A Elmbank Chiropractic Clinic'),
    ).toEqual(['Fenwick Chiropractic Ltd', 'Elmbank Chiropractic Clinic']);
    expect(registerNames('Acme Ltd trading as Acme Dental')).toEqual([
      'Acme Ltd',
      'Acme Dental',
    ]);
    expect(registerNames('Acme Ltd (t/a Acme Dental)')).toEqual([
      'Acme Ltd',
      'Acme Dental',
    ]);
    expect(registerNames('Acme Holdings Ltd. T/As Acme Kebabs')).toEqual([
      'Acme Holdings Ltd.',
      'Acme Kebabs',
    ]);
    expect(registerNames('ACME OF DEEPING LTD TA ACMES')).toEqual([
      'ACME OF DEEPING LTD',
      'ACMES',
    ]);
    // A spelling the mapping's parser misses.
    expect(registerNames('Acme Ltd.T/A Acme Dental')).toEqual([
      'Acme Ltd.',
      'Acme Dental',
    ]);
  });

  test("drops a care-of agent and a company number, which are not the company's names", () => {
    // The agent's office is the registered office, so its site shows the postcode.
    expect(
      registerNames('Acme Widgets Ltd C/O Smith & Co Accountants'),
    ).toEqual(['Acme Widgets Ltd']);
    expect(registerNames('ACME HOMECARE LIMITED (Co Reg: 03260168)')).toEqual([
      'ACME HOMECARE LIMITED',
    ]);
  });

  test('never splits inside a name: words, slashes or a pipe', () => {
    expect(registerNames('ACME WIDGETS LIMITED')).toEqual([
      'ACME WIDGETS LIMITED',
    ]);
    expect(registerNames('ACME TRADING ASSOCIATES LTD')).toEqual([
      'ACME TRADING ASSOCIATES LTD',
    ]);
    expect(registerNames('BEST/ACME LTD')).toEqual(['BEST/ACME LTD']);
    // The register writes a pipe inside a trading name, never between names.
    expect(
      registerNames('Acme Sweets Ltd TA Acme Sweets | Cakes | Snacks'),
    ).toEqual(['Acme Sweets Ltd', 'Acme Sweets | Cakes | Snacks']);
  });
});

describe('hostIsWholeName', () => {
  test('a domain that is the whole name run together', () => {
    expect(
      hostIsWholeName('www.qx-associates.co.uk', 'QX ASSOCIATES LTD'),
    ).toBe(true);
    expect(hostIsWholeName('7b.co.uk', '7B LIMITED')).toBe(true);
    expect(
      hostIsWholeName('qxassociates.com', 'THE QX ASSOCIATES (U.K.) LIMITED'),
    ).toBe(true);
    expect(
      hostIsWholeName('www.qxassociates-london.co.uk', 'QX ASSOCIATES LTD'),
    ).toBe(true);
  });

  test('with or without a leading THE or a trailing form word', () => {
    expect(
      hostIsWholeName('www.theqx-associates.co.uk', 'THE QX ASSOCIATES LTD'),
    ).toBe(true);
    expect(
      hostIsWholeName('www.qx-associates-uk.com', 'QX ASSOCIATES LTD'),
    ).toBe(true);
    expect(hostIsWholeName('abc.co.uk', 'ABC U.K.LIMITED')).toBe(true);
  });

  test('only the whole name', () => {
    expect(hostIsWholeName('qx.co.uk', 'QX ASSOCIATES LTD')).toBe(false);
    expect(
      hostIsWholeName('qxassociatesgroup.co.uk', 'QX ASSOCIATES LTD'),
    ).toBe(false);
  });

  test('a name of only generic words names nothing', () => {
    expect(
      hostIsWholeName('global-solutions.co.uk', 'GLOBAL SOLUTIONS LTD'),
    ).toBe(false);
  });
});

describe('pageHasWholeName', () => {
  test('the whole name as one phrase, spaced or run together, closed by its legal form', () => {
    expect(pageHasWholeName('Welcome to Starcare PLC', 'STAR CARE PLC')).toBe(
      true,
    );
    expect(pageHasWholeName('Star-Care plc homes', 'STAR CARE PLC')).toBe(true);
    expect(
      pageHasWholeName('The Rose & Crown Ltd, Unit 2', 'ROSE AND CROWN LTD'),
    ).toBe(true);
    expect(pageHasWholeName('Star-Care homes', 'STAR CARE PLC')).toBe(false);
  });

  test('never inside another word or across a wider gap', () => {
    expect(pageHasWholeName('AQX Associates Ltd', 'QX ASSOCIATES LTD')).toBe(
      false,
    );
    expect(pageHasWholeName('QX Associateship Ltd', 'QX ASSOCIATES LTD')).toBe(
      false,
    );
    expect(pageHasWholeName('Star -- Care PLC', 'STAR CARE PLC')).toBe(false);
  });

  test('a name of only generic words says nothing on a page', () => {
    expect(
      pageHasWholeName('Global Solutions Ltd, Unit 4', 'GLOBAL SOLUTIONS LTD'),
    ).toBe(false);
  });
});

describe('pageNamesCompany', () => {
  test('every word that says which company it is, as whole words', () => {
    expect(
      pageNamesCompany(
        'Acme Widgets Ltd, 1 High Street',
        'ACME WIDGETS LIMITED',
      ),
    ).toBe(true);
    expect(
      pageNamesCompany('Acme Lighting, 1 High Street', 'ACME WIDGETS LIMITED'),
    ).toBe(false);
    expect(
      pageNamesCompany('AcmeWidgets.example', 'ACME WIDGETS LIMITED'),
    ).toBe(false);
  });

  test('the words together, as a name is written, not scattered across listings', () => {
    expect(
      pageNamesCompany(
        'Rose Garden Florist, Unit 2. Hill Street Bakery, Unit 3.',
        'ROSE BAKERY LTD',
      ),
    ).toBe(false);
    expect(
      pageNamesCompany('Rose & Co. Bakery, Unit 2', 'ROSE BAKERY LTD'),
    ).toBe(true);
  });

  test('generic words need not appear', () => {
    expect(
      pageNamesCompany(
        'Acme Widgets head office',
        'ACME WIDGETS EUROPE LIMITED',
      ),
    ).toBe(true);
  });

  test('a name with nothing distinctive cannot be read off a page', () => {
    expect(pageNamesCompany('M&G, 10 Fenchurch Avenue', 'M&G FA LIMITED')).toBe(
      false,
    );
  });
});
