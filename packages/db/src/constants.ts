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
