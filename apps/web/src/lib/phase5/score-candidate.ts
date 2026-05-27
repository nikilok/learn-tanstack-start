/**
 * Pure sponsor-fit scorer for the Phase 5 inline resolver. Answers the
 * single question: "how well does this CH candidate fit this HMRC sponsor?"
 *
 * No I/O, no DB, no fetches, no comparison to a baseline. Unit-testable with
 * a single fixture profile + sponsor. Pairwise comparison logic lives in
 * [compare-candidates.ts](./compare-candidates.ts).
 *
 * Score range: `-Infinity` (route-type-incompatible) to `+4` (active +
 * matching locality). The doc's original `+6` ceiling assumed a
 * postcode-area feature, but `hmrc_skilled_workers` carries no postcode
 * column, so that feature is deliberately dropped.
 *
 * See docs/phase5-sweep-algorithm.md §"`scoreCandidate` — pure sponsor-fit
 * scorer".
 */

import { routeTypeCompatible } from './route-type-compat.ts';

/** Structural subset of `CHFullProfile` carrying only the fields the scorer
 *  reads. Loose so it stays compatible with the resolver's profile shape
 *  declared in `apps/web/src/lib/hmrc-ch/resolve-sponsor.ts`. */
export type ScorerCandidate = {
  company_status?: string | null;
  type?: string | null;
  registered_office_address?: {
    locality?: string | null;
  } | null;
};

/** Sponsor context the scorer needs: the HMRC route (for the hard gate) and
 *  the town/city (for the locality feature). */
export type ScorerSponsor = {
  route: string | null;
  townCity: string | null;
};

/** Lowercase + trim for case-insensitive locality comparison. */
function normaliseLocality(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Returns a numeric fitness score for the candidate against the sponsor.
 *  `-Infinity` signals a hard-gate failure (route-type incompatible). */
export function scoreCandidate(
  candidate: ScorerCandidate,
  sponsor: ScorerSponsor,
): number {
  if (!routeTypeCompatible(sponsor.route, candidate.type)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  const candidateLocality = normaliseLocality(
    candidate.registered_office_address?.locality,
  );
  const sponsorLocality = normaliseLocality(sponsor.townCity);
  if (
    candidateLocality &&
    sponsorLocality &&
    candidateLocality === sponsorLocality
  ) {
    score += 3;
  }

  // UK-incorporated entities use 'active' / 'dissolved' / 'liquidation';
  // uk-establishment (BR) and oversea-company (FC) records use 'open' /
  // 'closed' for the same operational meaning.
  const status = candidate.company_status;
  if (status === 'active' || status === 'open') score += 1;
  else if (
    status === 'dissolved' ||
    status === 'liquidation' ||
    status === 'closed'
  ) {
    score -= 2;
  }

  return score;
}
