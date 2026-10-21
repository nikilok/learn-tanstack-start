import { describe, expect, test } from 'bun:test';

import {
  hostNamesCompany,
  nameInitials,
  namesCompany,
  nameWords,
  pageNamesCompany,
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

  test('a three-letter word only where a label starts with it', () => {
    expect(
      hostNamesCompany('bizengineering.com', 'BIZ ENGINEERING LIMITED'),
    ).toBe(true);
    expect(hostNamesCompany('showbiz.co.uk', 'BIZ ENGINEERING LIMITED')).toBe(
      false,
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
  const name = 'ACME WIDGETS LIMITED';

  test('a page whose text names the company, whatever host served it', () => {
    expect(
      namesCompany('contractor.co.uk', 'Acme Widgets Ltd, SO22 5AZ', name),
    ).toBe(true);
  });

  test('a page served from a host carrying the name, whatever it says', () => {
    expect(namesCompany('acmewidgets.co.uk', 'SO22 5AZ', name)).toBe(true);
  });

  test("another business's page names neither way", () => {
    expect(
      namesCompany('contractor.co.uk', 'Our offices: SO22 5AZ', name),
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
