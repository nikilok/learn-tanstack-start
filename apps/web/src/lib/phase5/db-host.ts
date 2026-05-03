/**
 * Extract the host segment from a Postgres connection string. Used by the
 * Phase 5 scripts' "you are connected to ..." startup banner.
 *
 * SECURITY: never widen this to `new URL(url).host` — `url` contains the
 * password and `.toString()`/`.href` would leak it. Hand-rolled regex so
 * no URL object exists to accidentally expose other fields. Contract is
 * pinned by db-host.test.ts.
 */
export function describeDbHost(url: string | undefined): string {
  if (!url) return '(not set)';
  // The `[^@...]` clause prefers the last `@` before the path, handling
  // unencoded `@` in passwords (e.g. `user:p@ss@host/db` → `host`).
  const match = url.match(/@([^@/?#]+)(?:[/?#]|$)/);
  return match?.[1] ?? '(unparseable)';
}
