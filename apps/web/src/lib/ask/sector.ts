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
