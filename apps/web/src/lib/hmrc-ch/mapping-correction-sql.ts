/**
 * Database reads for correcting sponsor-to-company joins.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import type { ListedMapping } from './mapping-correction';

type Sql = NeonQueryFunction<false, false>;

type RawListed = {
  stored: Record<string, unknown>;
  organisation_name: string;
  company_number: string | null;
  match_method: string | null;
  query_used: string | null;
  verified_at: Date | null;
};

/** Read the listed mapping rows as stored now. */
export function makeReadMappings(sql: Sql) {
  return async (
    organisationNames: readonly string[],
  ): Promise<ListedMapping[]> => {
    // to_jsonb keeps each column as stored: a timestamp to the microsecond, in no time zone.
    const rows = await sql`
      SELECT to_jsonb(m) AS stored, m.organisation_name, m.company_number,
             m.match_method, m.query_used, m.verified_at
      FROM hmrc_company_mapping m
      WHERE m.organisation_name = ANY(${organisationNames}::text[])
    `;
    return (rows as RawListed[]).map((r) => ({
      stored: r.stored,
      organisationName: r.organisation_name,
      companyNumber: r.company_number,
      matchMethod: r.match_method,
      queryUsed: r.query_used,
      verifiedAt: r.verified_at,
    }));
  };
}
