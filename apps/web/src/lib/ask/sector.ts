// The sector a question named, carried between the plan and each further
// slice of its walk: a `sicSection` value the registry accepts.

import { canonicalSearchParams } from '@ss/search-filters';

/** Whether `value` is a sector as the URL carries one: section letters the registry accepts, in its canonical form, so a record or a request can be trusted with it. */
export function isSector(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    canonicalSearchParams({ sicSection: value }).sicSection === value
  );
}

/** Where the sector a question named ends up once its first slice was judged: carried by the ranking as a preference while something was there to rank, else the filter it was, which a failed rerank still lists under (an empty shortlist answers unmatched instead, lib/ask/outcome). No sector places nothing. */
export function placeSector(
  sector: string | null,
  shortlisted: number,
): { preference: string | null; filter: string | null } {
  if (sector === null) return { preference: null, filter: null };
  return shortlisted > 0
    ? { preference: sector, filter: null }
    : { preference: null, filter: sector };
}
