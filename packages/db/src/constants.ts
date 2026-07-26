/** SQL text slugifying an expression — the analogue of apps/web utils slugify. Single source for the 0038 expression indexes (schema.ts) and the rename-fallback WHERE clauses; the planner only uses the indexes while every copy stays textually identical. */
export function slugifiedSqlText(expr: string): string {
  return `btrim(regexp_replace(lower(${expr}), '[^a-z0-9]+', '-', 'g'), '-')`;
}

// Trail column_name values that constitute a registered-address change.
// Single source for the timeline's address-event curation (apps/web
// curate.ts), the /search hasMoved probe, and the idx_ch_trail_address_change
// partial-index predicate in schema.ts.
export const ADDRESS_COLUMNS = [
  'addressLine1',
  'addressLine2',
  'locality',
  'region',
  'postalCode',
  'country',
] as const;
