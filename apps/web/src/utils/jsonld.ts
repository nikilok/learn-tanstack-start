import { TYPE_RATING_ROWS } from '../lib/search/params';
import { FILTER_SECTIONS } from '../lib/search/sections';
import { APP_DESCRIPTION, APP_NAME, APP_SHORT_NAME } from './app-meta';

type Address = {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

export type CompanyJsonLdInput = {
  name: string;
  legalName: string;
  alternateName?: string | string[];
  // Every visa route the company can sponsor, already display-cased. An array,
  // not a pre-joined phrase: the FAQ answers need the count to pick singular
  // vs plural wording.
  routes: string[];
  // Raw HMRC rating string(s); faqPage phrases them via ratingPhrase.
  typeRating: string | string[];
  location: string;
  industry?: string;
  companyNumber?: string;
  dateOfCreation?: string;
  address?: Address | null;
  canonicalUrl: string;
  homeUrl: string;
};

// Grammatical joiner for multi-item phrases ("A-rated, B-rated and X").
const listFormatter = new Intl.ListFormat('en-GB', { type: 'conjunction' });

// Prose form of each rating tier in the registry, so an unparsed feed string
// never reaches visible copy (the raw values carry parentheses and, for the
// provisional tier, a trailing space that is real in the feed).
const TIER_PHRASES: Record<string, string> = {
  A: 'A-rated',
  'A-Premium': 'A-rated (Premium)',
  'A-SME+': 'A-rated (SME+)',
  B: 'B-rated',
  Provisional: 'provisionally rated',
};
const RAW_TO_PHRASE = new Map(
  TYPE_RATING_ROWS.map((row) => [row.raw, TIER_PHRASES[row.rating]]),
);

/** Render a natural-language rating phrase ("A-rated", "A-rated and B-rated") from one or more raw HMRC rating strings, deduped and grammatically joined. The single implementation for every surface. */
export function ratingPhrase(rating: string | string[]): string {
  const items = Array.isArray(rating) ? rating : [rating];
  const phrases = items.map((item) => {
    const known = RAW_TO_PHRASE.get(item);
    if (known) return known;
    // Unknown form (the feed adds tiers between ingests): parse the letter if
    // we can, else fall back to the trimmed raw string.
    const m = item.match(/\(([AB])\s+rating\)/i);
    return m ? `${m[1].toUpperCase()}-rated` : item.trim();
  });
  return listFormatter.format([...new Set(phrases.filter(Boolean))]);
}

/** Build a schema.org PostalAddress from a Companies House registered-office address; returns null when no usable fields exist. */
function postalAddress(address: Address | null | undefined) {
  if (!address) return null;
  const streetAddress = [address.address_line_1, address.address_line_2]
    .filter(Boolean)
    .join(', ');
  const parts: Record<string, string> = { '@type': 'PostalAddress' };
  if (streetAddress) parts.streetAddress = streetAddress;
  if (address.locality) parts.addressLocality = address.locality;
  if (address.region) parts.addressRegion = address.region;
  if (address.postal_code) parts.postalCode = address.postal_code;
  if (address.country) parts.addressCountry = address.country;
  if (Object.keys(parts).length === 1) return null;
  if (!parts.addressCountry) parts.addressCountry = 'GB';
  return parts;
}

/** Build an Organization schema describing the sponsor — includes legal name, Companies House identifier, founding date, and registered address when available. */
function organization(input: CompanyJsonLdInput) {
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.name,
    legalName: input.legalName,
    url: input.canonicalUrl,
  };
  // schema.org allows alternateName to be a single value or a list. Emit a bare
  // string for one alias (cleaner) and an array for several; omit when empty
  // (an empty array is truthy, so it must be length-checked, not `if`-checked).
  const altNames = Array.isArray(input.alternateName)
    ? input.alternateName
    : input.alternateName
      ? [input.alternateName]
      : [];
  if (altNames.length === 1) org.alternateName = altNames[0];
  else if (altNames.length > 1) org.alternateName = altNames;
  if (input.dateOfCreation) org.foundingDate = input.dateOfCreation;
  if (input.companyNumber) {
    org.identifier = {
      '@type': 'PropertyValue',
      propertyID: 'UK Companies House registration number',
      value: input.companyNumber,
    };
  }
  const address = postalAddress(input.address);
  if (address) org.address = address;
  return org;
}

/** Build a BreadcrumbList placing the company under the site Home. Location tier is omitted until we have city pages to link. */
function breadcrumbList(input: CompanyJsonLdInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: input.homeUrl,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: input.name,
        item: input.canonicalUrl,
      },
    ],
  };
}

/** Build a FAQPage block answering the four most common sponsor queries; each answer pulls only from data we already loaded. */
function faqPage(input: CompanyJsonLdInput) {
  const { name, routes, typeRating, location } = input;
  const rating = ratingPhrase(typeRating);
  const routeList = listFormatter.format(routes);
  const locationPhrase = location ? ` in ${location}` : '';
  const based = location
    ? `${name} is based${locationPhrase}, United Kingdom.`
    : `${name} is based in the United Kingdom.`;
  // Singular vs plural matters here: the answer is read aloud by assistants,
  // and "holds a X, Y and Z visa sponsor licence" reads as one malformed name.
  const licenceSentence =
    routes.length > 1
      ? `${name} holds UK Home Office sponsor licences for ${routeList} visas.`
      : `${name} holds a ${routeList} visa sponsor licence with the UK Home Office.`;

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: `Is ${name} a UK visa sponsor?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `Yes. ${name} is a licensed UK ${routeList} visa sponsor on the Home Office register of licensed sponsors${locationPhrase ? `,${locationPhrase}` : ''}.`,
        },
      },
      {
        '@type': 'Question',
        name: `Which visa routes can ${name} sponsor?`,
        acceptedAnswer: { '@type': 'Answer', text: licenceSentence },
      },
      {
        '@type': 'Question',
        name: `Where is ${name} based?`,
        acceptedAnswer: { '@type': 'Answer', text: based },
      },
      {
        '@type': 'Question',
        name: `What is ${name}'s sponsor licence rating?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `${name} holds ${rating} sponsor status on the UK Home Office register.`,
        },
      },
    ],
  };
}

/** Compose the three JSON-LD blocks (Organization, BreadcrumbList, FAQPage) for a company detail page. Each block is independently emitted as its own <script type="application/ld+json"> tag. */
export function buildCompanyJsonLd(input: CompanyJsonLdInput) {
  return [organization(input), breadcrumbList(input), faqPage(input)];
}

/** Build the home page's WebSite schema — canonical site name plus the word-order variants searchers type as alternateName, and the site-search action. This is the block search engines read site name/aliases from. */
export function buildWebsiteJsonLd(homeUrl: string) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: APP_SHORT_NAME,
      alternateName: [
        'UK Sponsor Search',
        'Sponsor Search UK',
        APP_NAME,
        'UK Visa Sponsor Search',
      ],
      url: homeUrl,
      description: APP_DESCRIPTION,
      inLanguage: 'en-GB',
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${homeUrl}?search={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
  ];
}

/** Compose the /filters page JSON-LD — a WebPage block plus an ItemList naming each filter dimension (from FILTER_SECTIONS) for crawlers and AI assistants. */
export function buildFiltersJsonLd(input: {
  title: string;
  description: string;
  canonicalUrl: string;
}) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: input.title,
      description: input.description,
      url: input.canonicalUrl,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Sponsor filter dimensions',
      description:
        'Ways the UK sponsorship list can be filtered on SponsorSearch.',
      itemListElement: FILTER_SECTIONS.flatMap((section) =>
        section.schemaLabel ? [section.schemaLabel] : [],
      ).map((name, position) => ({
        '@type': 'ListItem',
        position: position + 1,
        name,
      })),
    },
  ];
}

/** Build a SoftwareApplication schema for the /download page — a free macOS & Windows desktop app. Static (no per-release version data), so it's safe to emit on every render. */
export function buildDownloadJsonLd(input: {
  description: string;
  canonicalUrl: string;
}) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: APP_SHORT_NAME,
      description: input.description,
      url: input.canonicalUrl,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'macOS, Windows',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'GBP',
      },
    },
  ];
}
