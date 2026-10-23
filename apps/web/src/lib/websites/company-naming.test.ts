import { describe, expect, test } from 'bun:test';

import {
  hostIsWholeName,
  hostNamesCompany,
  nameInitials,
  namesCompany,
  nameWords,
  pageHasWholeName,
  pageNamesCompany,
  registerNames,
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
  // registered one: rejected until the register's names counted.
  const trading = {
    companyName: 'FENWICK CHIROPRACTIC LTD',
    sponsorNames: ['Fenwick Chiropractic Ltd T/A Elmbank Chiropractic Clinic'],
  };

  test("a site under the sponsor register's trading name, by its host", () => {
    const text = 'Book online. 209 High Road, SO22 5AZ';
    expect(namesCompany('www.elmbankchiropractic.co.uk', text, trading)).toBe(
      true,
    );
    expect(
      namesCompany('www.elmbankchiropractic.co.uk', text, {
        ...trading,
        sponsorNames: [],
      }),
    ).toBe(false);
  });

  test("a site under the sponsor register's trading name, in its text", () => {
    expect(
      namesCompany(
        'www.clinic-bookings.co.uk',
        'Elmbank Chiropractic Clinic, 209 High Road, SO22 5AZ',
        trading,
      ),
    ).toBe(true);
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
      namesCompany(
        'www.example.co.uk',
        'QX Associates Limited, SO22 5AZ',
        shortName,
      ),
    ).toBe(true);
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

describe('registerNames', () => {
  test('splits an entry at its trading name', () => {
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
    expect(registerNames('Acme Widgets LLP | Acme Services LLP')).toEqual([
      'Acme Widgets LLP',
      'Acme Services LLP',
    ]);
  });

  test('leaves a name without one, or with the letters inside words, whole', () => {
    expect(registerNames('ACME WIDGETS LIMITED')).toEqual([
      'ACME WIDGETS LIMITED',
    ]);
    expect(registerNames('ACME TRADING ASSOCIATES LTD')).toEqual([
      'ACME TRADING ASSOCIATES LTD',
    ]);
    expect(registerNames('BEST/ACME LTD')).toEqual(['BEST/ACME LTD']);
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
  test('the whole name as one phrase, spaced or run together', () => {
    expect(pageHasWholeName('Welcome to Starcare PLC', 'STAR CARE PLC')).toBe(
      true,
    );
    expect(pageHasWholeName('Star-Care homes', 'STAR CARE PLC')).toBe(true);
    expect(
      pageHasWholeName('I-AM Associates, London', 'I AM ASSOCIATES LIMITED'),
    ).toBe(true);
    expect(
      pageHasWholeName('The Rose & Crown, Unit 2', 'ROSE AND CROWN LTD'),
    ).toBe(true);
  });

  test('never inside another word, across a line or a wider gap', () => {
    expect(pageHasWholeName('AQX Associates', 'QX ASSOCIATES LTD')).toBe(false);
    expect(pageHasWholeName('QX Associateship', 'QX ASSOCIATES LTD')).toBe(
      false,
    );
    expect(pageHasWholeName('Star\nCare homes', 'STAR CARE PLC')).toBe(false);
    expect(pageHasWholeName('Star -- Care homes', 'STAR CARE PLC')).toBe(false);
  });

  test('a name too short, or only generic, says nothing on a page', () => {
    expect(pageHasWholeName('Unit 7B, High Street', '7B LIMITED')).toBe(false);
    expect(
      pageHasWholeName(
        'Global solutions for every business',
        'GLOBAL SOLUTIONS LTD',
      ),
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
