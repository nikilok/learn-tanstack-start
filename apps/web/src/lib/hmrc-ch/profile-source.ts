import type { HmrcLocation } from './resolve-sponsor';

/** The `hmrc_company_mapping` fields that route a profile lookup. */
export type Mapping = { companyNumber: string | null; verifiedAt: Date | null };

/** Where getCompanyProfile finds a profile: nowhere (`none` answers null), the profile cache, a Companies House fetch of the mapped company, or the resolver. */
export type ProfileSource<Row> =
  | { kind: 'none' }
  | { kind: 'cached'; row: Row }
  | { kind: 'fetch'; companyNumber: string }
  | { kind: 'resolve'; location: HmrcLocation };

/** The reads that route a profile lookup for one organisation. */
export type ProfileReads<Row> = {
  mapping: () => Promise<Mapping | undefined>;
  cachedProfile: (companyNumber: string) => Promise<Row | undefined>;
  /** The organisation's first register row, or undefined when it is not on the register. */
  registerRow: () => Promise<HmrcLocation | undefined>;
};

/**
 * Routes a profile lookup. A mapping with a company number is answered from
 * the profile cache when it can be; a lookup that calls Companies House, and
 * persists what it learns, is made only for an organisation on the register.
 */
export async function profileSource<Row>(
  reads: ProfileReads<Row>,
): Promise<ProfileSource<Row>> {
  const mapping = await reads.mapping();
  const companyNumber = mapping?.companyNumber;
  if (companyNumber) {
    const row = await reads.cachedProfile(companyNumber);
    if (row) return { kind: 'cached', row };
  } else if (mapping && mapping.verifiedAt !== null) {
    // Verified to point at no CH entity: a public body or a no_match verdict.
    return { kind: 'none' };
  }

  // ingest-hmrc-csv.ts stubs (no number, unverified) resolve on a first visit.
  // Mappings outlive register membership, so check it before calling CH.
  const location = await reads.registerRow();
  if (!location) return { kind: 'none' };

  return companyNumber
    ? { kind: 'fetch', companyNumber }
    : { kind: 'resolve', location };
}
