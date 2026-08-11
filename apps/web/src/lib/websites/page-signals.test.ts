import { describe, expect, test } from 'bun:test';

import { isAggregatorHost, looksChallenged, looksParked } from './page-signals';

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

describe('assertions use the host callers actually see, post-redirect', () => {
  test('a Maps link is judged as www.google.com, because that is where it lands', () => {
    // maps.google.com 302s to www.google.com/maps, and both callers pass the
    // POST-redirect host. Listing maps.google.com instead of google.com is a
    // rule that can never fire.
    expect(isAggregatorHost('www.google.com')).toBe(true);
    expect(isAggregatorHost('google.com')).toBe(true);
  });

  test('Google Sites is exempt, so a small company keeps its real website', () => {
    expect(isAggregatorHost('sites.google.com')).toBe(false);
  });

  test('subdomains of a listed host need no entry of their own', () => {
    // The claim that justified deleting four entries. Asserted on a host that
    // has no entry of its own, so re-adding one would not change the result.
    expect(isAggregatorHost('suite.endole.co.uk')).toBe(true);
    expect(isAggregatorHost('reports.endole.co.uk')).toBe(true);
    expect(isAggregatorHost('data.opencorporates.com')).toBe(true);
  });
});

describe('looksChallenged', () => {
  test('catches a WAF interstitial behind a 200', () => {
    expect(
      looksChallenged(
        'www.example.co.uk Verifying you are human. This may take a few seconds. Just a moment... Enable JavaScript and cookies to continue.',
      ),
    ).toBe(true);
    expect(
      looksChallenged('Checking your browser before accessing example.co.uk.'),
    ).toBe(true);
  });

  test('catches a VERBOSE interstitial that clears the old length gate', () => {
    // A multilingual WAF wall repeats its boilerplate past 1,500 chars — the
    // position check catches it because the challenge still leads the page.
    const verbose = `Just a moment... Verifying you are human. ${'This process is automatic. Your browser will redirect once verification is complete. Please enable JavaScript and cookies. Veuillez patienter. '.repeat(20)}`;
    expect(verbose.length).toBeGreaterThan(1500);
    expect(looksChallenged(verbose)).toBe(true);
  });

  test('does NOT reject a real page that discusses bot protection', () => {
    // A security vendor legitimately says the phrase in its body; position is
    // the discriminator — the article opens with its own content, so the
    // phrase sits past the interstitial head window.
    const intro =
      'Acme Networks helps growing companies stay online during traffic spikes and outages. Our engineers have decades of combined experience across finance, healthcare, and public services. We build resilient edge infrastructure tuned to each customer, with round-the-clock monitoring and a support team that answers in minutes, not days. Clients trust us to keep their storefronts fast and available through their busiest trading periods. ';
    const article = `${intro.repeat(2)}We provide managed DDoS protection by monitoring traffic at the edge. ${'Our platform inspects requests, rate-limits abusive clients and keeps genuine users flowing without friction. '.repeat(10)}`;
    expect(article.indexOf('DDoS protection by')).toBeGreaterThan(600);
    expect(looksChallenged(article)).toBe(false);
  });

  test('does NOT flag an ordinary short page', () => {
    expect(
      looksChallenged(
        'Contact us on 01234 567890 or visit us in Leigh on Sea.',
      ),
    ).toBe(false);
  });

  test('a security firm OPENING with the trade phrase is a real page', () => {
    // 'security check' is ordinary industry prose; only interstitial
    // framings (performing a security check / security checkpoint / check in
    // progress) classify, even inside the head window.
    const text = `Security check and patrol services for offices, events and construction sites across Kent. ${'Our licensed officers deliver manned guarding, keyholding and alarm response around the clock. '.repeat(8)}`;
    expect(looksChallenged(text)).toBe(false);
  });

  test('interstitial framings still classify from the head', () => {
    expect(
      looksChallenged(
        `Performing a security check of your browser before continuing. ${'Please wait while we verify your connection. '.repeat(4)}`,
      ),
    ).toBe(true);
  });
});
