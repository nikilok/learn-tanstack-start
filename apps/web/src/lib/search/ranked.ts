// The ask's ranked set as a listing restriction: the rows of exactly these
// companies, in the order given.

import { type SQL, sql } from 'drizzle-orm';

/** The condition keeping only these companies, and the order that puts them as ranked. */
export function rankedRestriction(ids: string[]): { cond: SQL; orderBy: SQL } {
  return {
    cond: sql`c.company_number = ANY(${sql.param(ids)}::text[])`,
    orderBy: sql`array_position(${sql.param(ids)}::text[], c.company_number::text) ASC, min(h.hash) ASC`,
  };
}
