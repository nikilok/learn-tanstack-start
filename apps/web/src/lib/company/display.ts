import {
  formatLocation,
  normalizeName,
  skilledWorkerFirst,
  titleCase,
} from '../../utils';
import { ratingPriorityFirst } from '../search/params';
import {
  type LicenceRow,
  licencesVary,
  ratingLabel,
  ratingPhrase,
  ratingTiersDiffer,
  routeLicences,
} from './licences';

// Grammatical "A, B and C" joiner for the routes and former-names sentences.
const listFormatter = new Intl.ListFormat('en-GB', { type: 'conjunction' });

/** A Companies House registered-office address, as the profile RPC returns it. */
export type RegisteredAddress = {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

/** The loader-data slice both head() and the page component derive from. */
export type CompanyDisplayInput = {
  sponsor: { licences: LicenceRow[] };
  profile?: {
    company_name?: string;
    previousNames?: string[];
    company_number?: string;
    date_of_creation?: string;
    registered_office_address?: RegisteredAddress | null;
    sicDescriptions?: { code: string; description: string }[];
  } | null;
};

/** Display location for a CH registered-office address. Mirrors searchHmrc's COALESCE(locality, address_line_2) + region so the detail page agrees with the listing card on whether a sponsor has a location. */
export function registeredLocation(address?: RegisteredAddress | null) {
  return formatLocation(
    address?.locality ?? address?.address_line_2,
    address?.region,
  );
}

/** Former Companies House names, with the current name, blanks, and normalised duplicates (LTD/LIMITED, repeats) removed. Single source for both the visible "previously known as" summary and the alternateName structured data, so page copy and JSON-LD can never diverge. */
export function formerCompanyNames(
  previousNames: string[] | undefined,
  currentName: string,
): string[] {
  const seen = new Set([normalizeName(currentName)]);
  const out: string[] = [];
  for (const raw of previousNames ?? []) {
    const key = normalizeName(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Distinct visa routes of a company's licence rows, in shared display priority order. */
export function distinctRoutes(licences: { route: string }[]): string[] {
  return skilledWorkerFirst([...new Set(licences.map((l) => l.route))]);
}

/** Distinct licence ratings, in shared best-tier-first priority order (same policy as the listing card's icon). */
export function distinctRatings(licences: { typeRating: string }[]): string[] {
  return ratingPriorityFirst([...new Set(licences.map((l) => l.typeRating))]);
}

/**
 * Every derived value the company page shows, computed ONCE so the visible
 * copy, the meta description and the JSON-LD can never drift apart. head() and
 * the component both call this with the same loader data.
 */
export function deriveCompanyDisplay({
  sponsor,
  profile,
}: CompanyDisplayInput) {
  // licences[0] is the primary org by construction (rows arrive primary-first).
  const primaryOrg = sponsor.licences[0]?.organisationName ?? '';
  // The whole pool: poolForPrimary already split off any DIFFERENT mapped
  // company, and unmapped rows sharing a slug cannot be told apart by name
  // (see the note in licences.ts) — so the page shows every licence it has.
  const licences = sponsor.licences;
  const rawName = profile?.company_name ?? primaryOrg;
  const currentKey = normalizeName(rawName);
  // Set AFTER titleCase: case-variant HMRC rows of the same alias must not
  // render twice ("…as Acme Support Ltd and Acme Support Ltd").
  const registeredNames = [
    ...new Set(licences.map((l) => titleCase(l.organisationName))),
  ].filter((alias) => normalizeName(alias) !== currentKey);
  const routes = distinctRoutes(licences);
  const ratings = distinctRatings(licences);
  const routeLicenceList = routeLicences(licences);
  return {
    primaryOrg,
    rawName,
    // Identity-safe licence rows — licence numbers must be read from these,
    // never from the raw pool.
    licences,
    formerNames: formerCompanyNames(profile?.previousNames, rawName),
    name: titleCase(rawName),
    registeredNames,
    registeredAs: registeredNames.length
      ? listFormatter.format(registeredNames)
      : '',
    routes,
    routesText: listFormatter.format(routes.map(titleCase)),
    // Route → its own rating(s); the display pairs from this, never from the
    // two independent lists.
    routeLicences: routeLicenceList,
    ratings,
    ratingText: ratingPhrase(ratings),
    // "Worker (A Rating) for Skilled Worker" per licence, in the RAW register
    // wording: the "A-rated" shorthand collapses "Worker (A rating)" and
    // "Temporary Worker (A rating)" into one phrase, losing the licence type.
    licencePhrases: routeLicenceList.map(
      (l) =>
        `${l.ratings.map(ratingLabel).join(' and ')} for ${titleCase(l.route)}`,
    ),
    // Both from lib/company/licences, the same functions the FAQ JSON-LD uses.
    licencesVary: licencesVary(routeLicenceList),
    ratingTiersDiffer: ratingTiersDiffer(routeLicenceList),
    location: registeredLocation(profile?.registered_office_address),
    industry: profile?.sicDescriptions
      ?.map((sic) => sic.description)
      .join(', '),
    // Pairs for the visible caption; `industry` stays code-free for prose, meta and JSON-LD.
    sicEntries: profile?.sicDescriptions ?? [],
  };
}
