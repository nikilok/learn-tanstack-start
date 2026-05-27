/**
 * Maps HMRC sponsorship `route` values to the set of Companies House
 * `company_type` values eligible to hold that route. Encodes Home Office
 * sponsor licence rules.
 *
 * Auditable source of truth for the inline scorer's hard gate. Reviewable by
 * anyone, regardless of ML / scoring knowledge.
 *
 * Route values verified against `hmrc_skilled_workers.route` (17 distinct
 * values, 2026-05-27). Company-type values verified against
 * `companies_house_profiles.company_type` (20 distinct values, 2026-05-27 —
 * notably `ltd`, not `private-limited-company`).
 *
 * See docs/phase5-sweep-algorithm.md §"Route-type compatibility".
 */

export type HmrcRoute =
  | 'Skilled Worker'
  | 'Charity Worker'
  | 'Creative Worker'
  | 'Religious Worker'
  | 'Tier 2 Ministers of Religion'
  | 'International Sportsperson'
  | 'Scale-up'
  | 'Seasonal Worker'
  | 'Government Authorised Exchange'
  | 'International Agreement'
  | 'Intra Company Transfers (ICT)'
  | 'Intra-company Routes'
  | 'Global Business Mobility: Senior or Specialist Worker'
  | 'Global Business Mobility: Graduate Trainee'
  | 'Global Business Mobility: UK Expansion Worker'
  | 'Global Business Mobility: Service Supplier'
  | 'Global Business Mobility: Secondment Worker';

export type CHCompanyType =
  | 'ltd'
  | 'plc'
  | 'llp'
  | 'limited-partnership'
  | 'private-unlimited'
  | 'private-unlimited-nsc'
  | 'private-limited-guarant-nsc'
  | 'private-limited-guarant-nsc-limited-exemption'
  | 'private-limited-shares-section-30-exemption'
  | 'oversea-company'
  | 'uk-establishment'
  | 'royal-charter'
  | 'industrial-and-provident-society'
  | 'registered-society-non-jurisdictional'
  | 'charitable-incorporated-organisation'
  | 'scottish-charitable-incorporated-organisation'
  | 'assurance-company'
  | 'registered-overseas-entity'
  | 'unregistered-company'
  | 'converted-or-closed';

/** Corporate forms that can sponsor a worker on any commercial route — broadly,
 *  any active operating UK or overseas entity. */
const COMMERCIAL_FORMS: ReadonlySet<CHCompanyType> = new Set([
  'ltd',
  'plc',
  'llp',
  'limited-partnership',
  'private-unlimited',
  'private-unlimited-nsc',
  'private-limited-guarant-nsc',
  'private-limited-guarant-nsc-limited-exemption',
  'private-limited-shares-section-30-exemption',
  'oversea-company',
  'uk-establishment',
  'royal-charter',
  'industrial-and-provident-society',
  'registered-society-non-jurisdictional',
  'assurance-company',
  // CIOs can in principle sponsor commercial workers (a charity can employ a
  // skilled-worker visa holder for non-charitable activities), so they pass the
  // hard gate. Locality + status features still discriminate.
  'charitable-incorporated-organisation',
  'scottish-charitable-incorporated-organisation',
]);

/** Corporate forms typical of charitable / religious / not-for-profit sponsors.
 *  Excludes pure commercial forms (ltd, plc, llp, limited-partnership) that
 *  almost never hold a charity-route licence in practice. */
const NOT_FOR_PROFIT_FORMS: ReadonlySet<CHCompanyType> = new Set([
  'charitable-incorporated-organisation',
  'scottish-charitable-incorporated-organisation',
  'private-limited-guarant-nsc',
  'private-limited-guarant-nsc-limited-exemption',
  'royal-charter',
  'registered-society-non-jurisdictional',
  'industrial-and-provident-society',
]);

export const ROUTE_TYPE_COMPAT: Record<
  HmrcRoute,
  ReadonlySet<CHCompanyType>
> = {
  'Skilled Worker': COMMERCIAL_FORMS,
  'Creative Worker': COMMERCIAL_FORMS,
  'International Sportsperson': COMMERCIAL_FORMS,
  'Scale-up': COMMERCIAL_FORMS,
  'Seasonal Worker': COMMERCIAL_FORMS,
  'Government Authorised Exchange': COMMERCIAL_FORMS,
  'International Agreement': COMMERCIAL_FORMS,
  'Intra Company Transfers (ICT)': COMMERCIAL_FORMS,
  'Intra-company Routes': COMMERCIAL_FORMS,
  'Global Business Mobility: Senior or Specialist Worker': COMMERCIAL_FORMS,
  'Global Business Mobility: Graduate Trainee': COMMERCIAL_FORMS,
  'Global Business Mobility: UK Expansion Worker': COMMERCIAL_FORMS,
  'Global Business Mobility: Service Supplier': COMMERCIAL_FORMS,
  'Global Business Mobility: Secondment Worker': COMMERCIAL_FORMS,

  'Charity Worker': NOT_FOR_PROFIT_FORMS,
  'Religious Worker': NOT_FOR_PROFIT_FORMS,
  'Tier 2 Ministers of Religion': NOT_FOR_PROFIT_FORMS,
};

/** Returns true when the candidate company type is plausibly compatible with
 *  the sponsor's HMRC route. Missing/unknown inputs default to true (no info,
 *  no hard gate) — the scorer's other features then discriminate. */
export function routeTypeCompatible(
  route: string | null | undefined,
  companyType: string | null | undefined,
): boolean {
  if (!companyType) return true;
  if (!route || !(route in ROUTE_TYPE_COMPAT)) return true;
  return ROUTE_TYPE_COMPAT[route as HmrcRoute].has(
    companyType as CHCompanyType,
  );
}
