import { createHash } from 'node:crypto';

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

/**
 * A stable, non-identifying fingerprint of the database host.
 *
 * The startup banners exist so an operator can confirm which database a run is
 * pointed at. `describeDbHost` answers that by printing the host — which is
 * fine on a terminal and wrong in CI, because this repo is public and Actions
 * logs are world-readable. A Neon endpoint id, provider and region in a public
 * log is free reconnaissance and names a target for credential attacks.
 *
 * The fingerprint keeps the operational value and drops the disclosure: it
 * changes when the database changes, so prod and a branch are still
 * distinguishable, but it reveals neither. Use `describeDbHost` only where the
 * output cannot become public.
 */
export function dbFingerprint(url: string | undefined): string {
  const host = describeDbHost(url);
  if (host === '(not set)' || host === '(unparseable)') return host;
  return `#${createHash('sha256').update(host).digest('hex').slice(0, 8)}`;
}
