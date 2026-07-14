/**
 * Shared helpers for the backfill / sweep scripts: strict CLI-int parsing, the
 * env bootstrap (root + apps/web .env.local), and the run-abort error-rate
 * threshold. One module so arg/abort policy can't drift between scripts.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

/** Abort a bulk run once this fraction of processed rows have errored. */
export const ERROR_RATE_THRESHOLD = 0.1;

/** Parse a whole non-negative integer; rejects '', '1e3', '10.5', '100abc'. */
export function parseStrictInt(raw: string, label: string): number {
  if (!/^\d+$/.test(raw))
    throw new Error(
      `Invalid ${label}="${raw}" — must be a whole non-negative integer`,
    );
  return Number.parseInt(raw, 10);
}

/**
 * Load env from the monorepo root and apps/web `.env.local` (pass the caller's
 * `import.meta.url`), then assert POSTGRES_URL is set. Callers under
 * apps/web/scripts resolve root at ../../../.env.local.
 */
export function loadScriptEnv(importMetaUrl: string): void {
  const scriptDir = dirname(fileURLToPath(importMetaUrl));
  const rootEnv = resolve(scriptDir, '../../../.env.local');
  const appEnv = resolve(scriptDir, '../.env.local');
  dotenv.config({ path: rootEnv });
  dotenv.config({ path: appEnv });
  if (!process.env.POSTGRES_URL)
    throw new Error(`POSTGRES_URL not in ${rootEnv} or ${appEnv}`);
}
