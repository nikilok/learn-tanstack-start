/**
 * Signals read off a fetched page that say whether a URL still belongs to the
 * company we recorded it for. No I/O.
 *
 * What corroborates a row is the company's REGISTERED OFFICE POSTCODE appearing
 * on the page (see revalidate.ts). An earlier version matched the company's
 * NAME against the hostname and the page text, and it was abandoned after two
 * review rounds produced eight defects in it, failing in both directions:
 * `LEEDS TEACHING HOSPITALS NHS TRUST` confirmed against a different trust's
 * site because `nhs` is in the TLD and on every NHS page by definition,
 * `WALES CARE LIMITED` confirmed against walesrugby.co.uk, and
 * `HEALTHCARE HOMES (LSC) LIMITED` failed to match healthcarehomes.co.uk — the
 * example its own docstring gave as the reason its fallback existed. Matching
 * generic English words against hostnames has no stable stopping point; a
 * postcode either appears or it does not.
 *
 * Measured on 150 live company sites (2026-08-01): the registered postcode
 * appears on 59.3%, the registration number on 28.0%, one or the other on
 * 64.7%. So the exact signal is also the more available one.
 *
 * What remains here is the two page-shape checks, which are about the PAGE
 * rather than the company and were never part of that problem.
 */

/**
 * Directory and profile hosts. A row pointing at one of these is a listing,
 * not the company's website, however accurate the listing may be.
 *
 * This list was sized when the only inputs were registry URLs, where a
 * directory was a rare mistake. It is now also the sole filter standing over a
 * SEARCH ENGINE's top five results for a UK company name, where directories
 * are not the exception but the bulk of the page — and every one of them
 * prints the registration number it was asked about, which is precisely the
 * signal the ladder trusts most. An unlisted directory therefore does not
 * degrade to a weak match; it lands at `crn_on_page`, 0.990, published, with
 * the company's own page confirming it. The list has to cover the SERP, not
 * just the registry.
 *
 * `nhs.uk` is deliberately NOT here. GP practices legitimately run their sites
 * on NHS-hosted domains, and including it wrongly rejected two correct rows in
 * the sample (Eightlands Surgery, The Town Surgery).
 */
const AGGREGATOR_HOSTS = [
  // Care sector
  'carehome.co.uk',
  'carehomes.co.uk',
  'cqc.org.uk',
  'autumna.co.uk',
  'lottie.org',
  'homecare.co.uk',
  // Official registers. A company's own filings are not its website.
  'companieshouse.gov.uk',
  'find-and-update.company-information.service.gov.uk',
  'thegazette.co.uk',
  // Specific registers only: `<council>.gov.uk` is a sponsor's real website.
  'charitycommission.gov.uk',
  'ofsted.gov.uk',
  'fca.org.uk',
  // UK company-data resellers. These rank hard on "<name> ltd" queries and
  // every one of them reprints the CRN.
  'endole.co.uk',
  'opencorporates.com',
  'bizdb.co.uk',
  'checkcompany.co.uk',
  'companiesintheuk.co.uk',
  'company-director-check.co.uk',
  'companycheck.co.uk',
  'creditsafe.com',
  'dnb.com',
  'globaldatabase.com',
  'kompass.com',
  'cylex-uk.co.uk',
  'company-information.co.uk',
  'ukbusinessdirectory.co.uk',
  'thecompanycheck.com',
  'companiesuk.info',
  'bizzdirect.co.uk',
  'businessmagnet.co.uk',
  'freecompanyaccounts.co.uk',
  'companydirectorcheck.com',
  'companiesuk.net',
  'datalog.co.uk',
  'ukcompanieslist.co.uk',
  'northdata.com',
  'bloomberg.com',
  'crunchbase.com',
  'zaubacorp.com',
  // Social, review and jobs profiles.
  'yell.com',
  'facebook.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'yelp.co.uk',
  'yelp.com',
  'trustpilot.com',
  'glassdoor.co.uk',
  'indeed.com',
  'reed.co.uk',
  'totaljobs.com',
  'cv-library.co.uk',
  'wikipedia.org',
  'thomsonlocal.com',
  'scoot.co.uk',
  'freeindex.co.uk',
  '192.com',
  'bark.com',
  'checkatrade.com',
  'rated-people.com',
  'trustatrader.com',
  'tripadvisor.co.uk',
  'tripadvisor.com',
  'google.com',
  'amazon.co.uk',
  'ebay.co.uk',
];

/** Hosts inside a listed domain that ARE a company's own site. */
const AGGREGATOR_EXEMPT_HOSTS = ['sites.google.com'];

/** Whether a host is a directory rather than a company's own site. */
export function isAggregatorHost(host: string): boolean {
  const clean = host.toLowerCase().replace(/^www\./, '');
  if (
    AGGREGATOR_EXEMPT_HOSTS.some(
      (exempt) => clean === exempt || clean.endsWith(`.${exempt}`),
    )
  ) {
    return false;
  }
  return AGGREGATOR_HOSTS.some(
    (aggregator) => clean === aggregator || clean.endsWith(`.${aggregator}`),
  );
}

/** Phrases that appear on a domain-for-sale, holding or default server page. */
const PARKED_PHRASES =
  /(domain (is |name )?(is )?for sale|buy this domain|this domain (name )?is (for sale|parked)|parked (free )?(courtesy|by)|godaddy\.com\/forsale|nameshift|dan\.com|sedo\.com|under construction|coming soon|site is being built|default web site page|welcome to nginx|apache2 (ubuntu|debian) default page|index of \/)/i;

/**
 * A page with nothing on it: parked, for sale, or a default server response.
 *
 * The phrase alone is not the test. Real sites say "coming soon" about a new
 * home and "under construction" about a wing, and matching on the phrase by
 * itself wrongly rejected three live sites in the sample. A genuine holding
 * page is also almost empty, so the length gate is what separates them — a real
 * homepage carries a navigation menu and far more than this.
 */
const PARKED_MAX_TEXT = 1500;

export function looksParked(visibleText: string): boolean {
  const flat = visibleText.replace(/\s+/g, ' ').trim();
  return flat.length < PARKED_MAX_TEXT && PARKED_PHRASES.test(flat);
}

/**
 * Below this a page cannot be taken as evidence of ABSENCE.
 *
 * A cookie wall, a JavaScript shell before hydration, or a body truncated at
 * the fetcher's 2MB cap all return 200 with almost no text. Not finding the
 * registered address on one of those says nothing about whether the site
 * publishes it, and treating it as a withdrawal makes a company's website
 * flicker off and back on across sweeps.
 *
 * Deliberately the same threshold looksParked uses: both are asking the same
 * question, whether there is enough here to have read.
 */
export function pageTooThin(visibleText: string): boolean {
  return visibleText.replace(/\s+/g, ' ').trim().length < PARKED_MAX_TEXT;
}

/** Phrases a WAF or bot-management interstitial shows a client it is
 *  challenging. Vendor-spanning by wording, not by brand name alone. */
const CHALLENGE_PHRASES =
  /(just a moment|checking your browser|verify(ing)? (that )?you are (a )?human|enable javascript and cookies|security check(point)?|attention required.{0,40}cloudflare|ddos protection by|browser verification|are you a robot|access to this page has been denied)/i;

/** An interstitial leads with its challenge text; this is the window it must
 *  fall inside. Wide enough for a multilingual WAF wall, short enough that a
 *  real article mentioning "DDoS protection" in its body sits past it. */
const CHALLENGE_HEAD_CHARS = 600;

/**
 * A 200 response that is a bot challenge rather than the page. The phrase
 * alone is not the test, same as looksParked: a security vendor's real site
 * legitimately says "DDoS protection" in prose. But a total-length gate lets a
 * verbose (multilingual) interstitial through as ok corpus text, so the
 * discriminator is POSITION instead — a challenge page opens with its
 * challenge; an article opens with its own content and buries the phrase.
 */
export function looksChallenged(visibleText: string): boolean {
  const head = visibleText
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHALLENGE_HEAD_CHARS);
  return CHALLENGE_PHRASES.test(head);
}
