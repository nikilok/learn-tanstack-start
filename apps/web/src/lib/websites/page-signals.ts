/**
 * Signals read off a fetched page that say whether a URL still belongs to the
 * company we recorded it for. No I/O.
 *
 * The registry tier records what a regulator asserted, and nothing re-checks
 * that assertion afterwards. Measured over a 200-row hand-labelled sample
 * (2026-08-01) the tier is 90% precise overall, but that average hides two
 * populations: rows where the company's own name appears in both the hostname
 * and the page were 133/133 correct, while rows where it appears nowhere were
 * 14/29. Every wrong row was in the second group.
 *
 * So the useful question is not "is the registry trustworthy" but "does this
 * particular page corroborate what the registry said", which is what these
 * functions answer.
 */

/**
 * Words that identify no company in this corpus. Roughly one care provider in
 * three contains several of them, so leaving them in makes "care" a match
 * between any two unrelated providers.
 */
const STOPWORDS = new Set([
  'limited',
  'ltd',
  'llp',
  'plc',
  'the',
  'and',
  'of',
  'group',
  'holdings',
  'care',
  'homes',
  'home',
  'health',
  'healthcare',
  'services',
  'service',
  'uk',
  'england',
  'living',
  'support',
  'community',
  'trust',
  'centre',
  'center',
  'medical',
  'clinic',
  'nursing',
  'residential',
  'house',
  'lodge',
]);

/** Legal suffixes, stripped before squashing a name for comparison. */
const SUFFIX = /\b(limited|ltd|llp|plc|cic|c\.i\.c|incorporated|inc)\b\.?/gi;

/** The tokens that actually identify a company, longest first. */
export function distinctiveTokens(name: string): string[] {
  return [
    ...new Set(
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  ].sort((a, b) => b.length - a.length);
}

/** A name reduced to comparable characters: no suffix, no punctuation, no spaces. */
export function squashName(name: string): string {
  return name
    .replace(SUFFIX, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Below this a squashed name is too generic to match on. "care" would
 * otherwise match carehome.co.uk, which is a directory rather than a company.
 */
const MIN_SQUASH = 6;

/** Whether two squashed strings are the same name, allowing one to carry an
 *  extra qualifier ("healthcarehomeslsc" vs the host's "healthcarehomes"). */
function squashMatches(a: string, b: string): boolean {
  if (a.length < MIN_SQUASH || b.length < MIN_SQUASH) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export type Corroboration = {
  /** Distinctive tokens found in the hostname. */
  inHost: string[];
  /** Distinctive tokens found in the page's visible text. */
  inText: string[];
  /** Whether the whole name matched the host, for companies made only of
   *  generic words ("Home Group Limited" -> homegroup.org.uk). */
  squashed: boolean;
  corroborated: boolean;
};

/**
 * Does this page corroborate that it belongs to this company?
 *
 * The host and the text must BOTH carry the name, and that pairing is what
 * carries the precision. Host alone is not enough: a lapsed domain keeps its
 * name while its content changes hands, which is how a care home's own address
 * came to serve an online casino in the sample. Text alone is not enough
 * either: a group or directory page names dozens of companies it does not
 * belong to.
 *
 * The squashed fallback exists for companies whose name is entirely generic
 * words, where `distinctiveTokens` correctly returns nothing and the rule would
 * otherwise be unable to confirm a site that plainly matches.
 */
export function nameCorroboration(
  companyName: string,
  host: string,
  visibleText: string,
): Corroboration {
  const tokens = distinctiveTokens(companyName);
  const lowerHost = host.toLowerCase();
  const flatText = visibleText.toLowerCase();

  const inHost = tokens.filter((token) => lowerHost.includes(token));
  const inText = tokens.filter((token) => flatText.includes(token));

  // Only when there are no distinctive tokens at all, so this can never
  // override the primary rule — it only covers the case it cannot express.
  let squashed = false;
  if (tokens.length === 0) {
    const name = squashName(companyName);
    const label = lowerHost.replace(/^www\./, '').split('.')[0] ?? '';
    squashed =
      squashMatches(name, label) &&
      flatText.replace(/[^a-z0-9]/g, '').includes(name);
  }

  return {
    inHost,
    inText,
    squashed,
    corroborated: squashed || (inHost.length > 0 && inText.length > 0),
  };
}

/**
 * Directory and profile hosts. A row pointing at one of these is a listing,
 * not the company's website, however accurate the listing may be.
 *
 * `nhs.uk` is deliberately NOT here. GP practices legitimately run their sites
 * on NHS-hosted domains, and including it wrongly rejected two correct rows in
 * the sample (Eightlands Surgery, The Town Surgery).
 */
const AGGREGATOR_HOSTS = [
  'carehome.co.uk',
  'carehomes.co.uk',
  'cqc.org.uk',
  'yell.com',
  'facebook.com',
  'linkedin.com',
  'companieshouse.gov.uk',
  'find-and-update.company-information.service.gov.uk',
  'endole.co.uk',
  'opencorporates.com',
  'bizdb.co.uk',
  'checkcompany.co.uk',
  'yelp.co.uk',
  'trustpilot.com',
];

/** Whether a host is a directory rather than a company's own site. */
export function isAggregatorHost(host: string): boolean {
  const clean = host.toLowerCase().replace(/^www\./, '');
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
