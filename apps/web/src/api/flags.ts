import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

import {
  downloadsFlag,
  evaluateFlag,
  FLAG_OVERRIDES_COOKIE,
} from '../flags.server';

/**
 * Server fn resolving the `downloads` feature flag: a signed Flags-Explorer
 * override cookie wins, else the Vercel dashboard value, else the default
 * (hidden). Evaluated server-side; the query below caches it for the session.
 * Never throws — flag resolution must not break page render.
 */
export const getDownloadsFlag = createServerFn().handler(async () => {
  try {
    return await evaluateFlag(downloadsFlag, getCookie(FLAG_OVERRIDES_COOKIE));
  } catch {
    return downloadsFlag.defaultValue;
  }
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
