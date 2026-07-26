import { normalizeName, skilledWorkerFirst } from '../../utils';
import { ratingPriorityFirst } from '../search/params';

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

/**
 * An UNMAPPED pool can hold genuinely distinct legal entities whose names
 * slugify alike ("SK & Associates Ltd" vs "SK Associates Ltd"), with no company
 * number to tell them apart. Routes, ratings, licence numbers and aliases are
 * all identity-bearing claims, so publish only the primary org's rows there.
 */
export function identitySafeLicences<
  T extends { organisationName: string; companyNumber: string | null },
>(licences: T[]): T[] {
  const primary = licences[0];
  if (!primary || primary.companyNumber != null) return licences;
  const names = new Set(licences.map((l) => normalizeName(l.organisationName)));
  if (names.size <= 1) return licences;
  const primaryKey = normalizeName(primary.organisationName);
  return licences.filter(
    (l) => normalizeName(l.organisationName) === primaryKey,
  );
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
