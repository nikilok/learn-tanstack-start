/**
 * The columns of `company_websites` that describe the address a row holds,
 * each with the value it goes back to when the address changes. One
 * declaration for every write that moves a row to another address. No I/O.
 */

/** Check and walk state: what was learned about one address says nothing about the next. Constant SQL text. */
export const URL_BOUND = {
  checked_at: 'NULL',
  failure_count: '0',
  evidence_url: 'NULL',
  walk_version: 'NULL',
  walk_attempts: '0',
  walked_at: 'NULL',
} as const;

/** A column that describes the address a row holds. */
export type UrlBoundColumn = keyof typeof URL_BOUND;
