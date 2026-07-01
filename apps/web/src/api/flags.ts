import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';

import { downloadsFlag, evaluateFlag } from '../flags.server';

/** Reads a single cookie value out of a Cookie header. */
function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Server fn resolving the `downloads` feature flag: a signed Flags-Explorer
 * override cookie wins, else the Vercel dashboard value, else the default
 * (hidden). Evaluated server-side; the query below caches it for the session.
 */
export const getDownloadsFlag = createServerFn().handler(async () => {
  const override = readCookie(
    getRequestHeader('cookie') ?? undefined,
    'vercel-flag-overrides',
  );
  return evaluateFlag(downloadsFlag, override);
});

/**
 * React Query options for the downloads flag. Evaluated once during SSR and
 * cached for the session (a full reload picks up a dashboard toggle).
 */
export const downloadsFlagQueryOptions = queryOptions({
  queryKey: ['flag', 'downloads'],
  queryFn: () => getDownloadsFlag(),
  staleTime: Number.POSITIVE_INFINITY,
});
