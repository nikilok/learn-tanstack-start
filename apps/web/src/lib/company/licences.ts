import { skilledWorkerFirst, titleCase } from '../../utils';
import { ratingPriorityFirst, TYPE_RATING_ROWS } from '../search/params';

/** A real (route, rating) pair from ONE licence row — never reassembled from separately-sorted route and rating lists. */
export type LicencePair = { route: string; rating: string };

/** A licence row as the company page loads it: the pair plus the identity and licence-number fields the page needs. */
export type LicenceRow = {
  organisationName: string;
  companyNumber: string | null;
  typeRating: string;
  route: string;
  sponsorLicenceNumber: string | null;
};

/** One visa route with the rating(s) held on THAT route. */
export type RouteLicence = { route: string; ratings: string[] };

/**
 * Namesake guard: keep only rows belonging to the slug's primary company —
 * the same company number, or unmapped rows which are name-keyed and so
 * indistinguishable. A DIFFERENT mapped company sharing the slug is a distinct
 * legal entity whose licences must never surface as this one's.
 * Rows arrive primary-first from the query.
 */
export function poolForPrimary<T extends { companyNumber: string | null }>(
  rows: T[],
): T[] {
  if (rows.length === 0) return rows;
  const primary = rows[0].companyNumber;
  return rows.filter(
    (row) => row.companyNumber === primary || row.companyNumber === null,
  );
}

// NOTE — there is deliberately no name-based "is this the same entity?" filter
// for unmapped pools. Rows share a slug precisely because their names slugify
// alike, and no normalisation can separate a spacing variant of ONE body
// ("University of Leeds (Human Resources)" vs "University of Leeds(Human
// Resources)" — one org, 4 routes) from two genuinely distinct companies
// ("SK & Associates Ltd" vs "SK Associates Ltd"). A guard keyed on
// normalizeName was tried and silently deleted 3 of the university's 4 real
// visa routes in production. Distinct MAPPED entities are separated properly:
// poolForPrimary splits them by company number here, and the ingest gives them
// their own suffixed slugs. Unmapped pools stay whole — under-splitting shows
// a real sponsor's real licences, over-splitting hides them.

// Grammatical joiner for multi-item rating phrases.
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

/**
 * Do the RAW register values vary across routes? Drives whether to spell the
 * route↔rating pairs out, so a Worker vs Temporary Worker split is still shown
 * even though both phrase as "A-rated".
 */
export function licencesVary(licences: { ratings: string[] }[]): boolean {
  return new Set(licences.map((l) => l.ratings.join('|'))).size > 1;
}

/**
 * Do the rating TIERS differ across routes? ONLY this may claim the rating
 * "differs by route" — asserting it for a company that is A-rated throughout
 * published a false distinction on ~3,289 pages.
 *
 * Both flags live here, not at each call site: the page copy and the FAQ
 * JSON-LD must agree, and two copies of one rule is the defect class this
 * module exists to prevent.
 */
export function ratingTiersDiffer(licences: { ratings: string[] }[]): boolean {
  return new Set(licences.map((l) => ratingPhrase(l.ratings))).size > 1;
}

/** Display form of a raw register rating: title-cased and trimmed (the provisional tier carries a stray trailing space in the feed). The ONE label used by page prose, badges and FAQ text, so the visible copy and the structured data never disagree on casing. */
export function ratingLabel(raw: string): string {
  return titleCase(raw.trim());
}

/** Group licence rows into route → its own rating(s), in display priority order. Two separate route and rating lists would let a reader (or a crawler) pair the wrong two. */
export function routeLicences(
  licences: { typeRating: string; route: string }[],
): RouteLicence[] {
  const byRoute = new Map<string, Set<string>>();
  for (const { route, typeRating } of licences) {
    const set = byRoute.get(route) ?? new Set<string>();
    set.add(typeRating);
    byRoute.set(route, set);
  }
  return skilledWorkerFirst([...byRoute.keys()]).map((route) => ({
    route,
    ratings: ratingPriorityFirst([...(byRoute.get(route) ?? [])]),
  }));
}

/**
 * What a merged search card shows: the leading route and the rating held on
 * THAT route. The rating must never come from the row's own sorted rating list
 * — a company can be B-rated on Skilled Worker and A-rated elsewhere, so
 * independently-sorted heads advertise a pair the company does not hold.
 * `typeRatings` is a fallback ONLY for payloads predating `licences` (an
 * edge-cached response minted before that field shipped); when licences exist
 * but none matches the route the payload is inconsistent and no rating is
 * shown rather than borrowing another route's.
 */
export function cardLicence(row: {
  routes?: string[] | null;
  licences?: LicencePair[] | null;
  typeRatings?: string[] | null;
}): { chipRoute: string; rating: string; extraRoutes: number } {
  const routes = row.routes ?? [];
  const licences = row.licences ?? [];
  const chipRoute = skilledWorkerFirst(routes)[0] ?? '';
  const routeRatings = licences
    .filter((l) => l.route === chipRoute)
    .map((l) => l.rating);
  const legacyRatings = licences.length === 0 ? (row.typeRatings ?? []) : [];
  return {
    chipRoute,
    // '' keeps the always-present rating slot rendered (the virtual list's
    // fixedHeight assumes it) instead of throwing on an unexpected payload.
    rating:
      ratingPriorityFirst(
        routeRatings.length ? routeRatings : legacyRatings,
      )[0] ?? '',
    extraRoutes: Math.max(0, routes.length - 1),
  };
}
