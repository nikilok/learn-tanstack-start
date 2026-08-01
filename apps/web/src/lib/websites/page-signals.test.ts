import { describe, expect, test } from 'bun:test';

import { isAggregatorHost, looksParked } from './page-signals';

describe('isAggregatorHost', () => {
  test('rejects a directory listing', () => {
    // Beachcroft Homes Limited pointed at a carehome.co.uk listing page.
    expect(isAggregatorHost('www.carehome.co.uk')).toBe(true);
    expect(isAggregatorHost('opencorporates.com')).toBe(true);
  });

  test('does NOT reject an NHS-hosted practice site', () => {
    // GP practices legitimately run on nhs.uk, and listing it wrongly rejected
    // Eightlands Surgery and The Town Surgery, both correct rows.
    expect(isAggregatorHost('www.eightlandssurgery.nhs.uk')).toBe(false);
  });

  test('matches subdomains but not lookalike suffixes', () => {
    expect(isAggregatorHost('uk.linkedin.com')).toBe(true);
    expect(isAggregatorHost('notcarehome.co.uk')).toBe(false);
  });
});

describe('looksParked', () => {
  test('catches a domain-for-sale holding page', () => {
    expect(
      looksParked(
        'Dovendi - Domain for sale. This domain name is managed by Dovendi. I am interested.',
      ),
    ).toBe(true);
  });

  test('catches a placeholder on the company own domain', () => {
    expect(
      looksParked("Coming Soon pinnaclecarehome.com we're under construction."),
    ).toBe(true);
  });

  test('does NOT reject a real site that mentions the phrase in passing', () => {
    // Three live sites were wrongly rejected by phrase-matching alone: a real
    // provider says "coming soon" about a new home. The length gate is the
    // whole separation, so a long page carrying the phrase must survive.
    const realPage = `${'Home About us Our homes Our care Nursing care Dementia care Respite care Careers News Contact us. '.repeat(20)} Our new wing is coming soon.`;
    expect(realPage.length).toBeGreaterThan(1500);
    expect(looksParked(realPage)).toBe(false);
  });

  test('does not fire on a short page with no parking language', () => {
    expect(looksParked('Stoneacre Lodge residential home. 01302 882148.')).toBe(
      false,
    );
  });
});

describe('isAggregatorHost over a search engine result page', () => {
  // This list stopped being a registry-hygiene nicety when search discovery
  // started feeding it. It is now the only filter between a SERP for "<name>
  // ltd" — which is mostly company-data resellers — and a published website,
  // and every one of those resellers reprints the registration number the
  // query named. An unlisted directory does not become a weak match; it
  // becomes crn_on_page at 0.990 with the company's own number confirming it.
  const directories = [
    'companiesintheuk.co.uk',
    'www.thegazette.co.uk',
    'find-and-update.company-information.service.gov.uk',
    'www.endole.co.uk',
    'opencorporates.com',
    'creditsafe.com',
    'northdata.com',
    'uk.indeed.com',
    'www.glassdoor.co.uk',
    'uk.linkedin.com',
    'www.checkatrade.com',
    'en.wikipedia.org',
    'www.tripadvisor.co.uk',
    'register.fca.org.uk',
  ];
  for (const host of directories) {
    test(`${host} is a listing, not a company website`, () => {
      expect(isAggregatorHost(host)).toBe(true);
    });
  }

  test('nhs.uk stays off the list', () => {
    // GP practices legitimately run their sites on NHS-hosted domains, and
    // adding it rejected two correct rows in the sample.
    expect(isAggregatorHost('www.eightlandssurgery.nhs.uk')).toBe(false);
  });

  test('an ordinary company site is untouched', () => {
    expect(isAggregatorHost('www.brendoncare.org.uk')).toBe(false);
    expect(isAggregatorHost('acmecare.co.uk')).toBe(false);
  });

  test('matching is on the host, not a substring of it', () => {
    // `notyell.com` and `yell.com.example.co.uk` are not yell.com.
    expect(isAggregatorHost('notyell.com')).toBe(false);
    expect(isAggregatorHost('yell.com.example.co.uk')).toBe(false);
  });
});

describe('public bodies are sponsors too', () => {
  test('a council keeps its own gov.uk site', () => {
    // Blanket-listing gov.uk to catch the registers would reject the correct
    // answer for every local authority on the register.
    expect(isAggregatorHost('www.leeds.gov.uk')).toBe(false);
    expect(isAggregatorHost('birmingham.gov.uk')).toBe(false);
  });

  test('but the registers hosted on gov.uk are still listings', () => {
    expect(
      isAggregatorHost('register-of-charities.charitycommission.gov.uk'),
    ).toBe(true);
    expect(isAggregatorHost('reports.ofsted.gov.uk')).toBe(true);
  });
});
