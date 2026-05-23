import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

import { evaluateFlag, govukBranded } from '../flags.server';

/** Evaluates every declared flag for the current request and returns the resolved values. Route loaders call this via flagStateQueryOptions so values land in TanStack Query and survive client-side navigation. */
const getFlagState = createServerFn({ method: 'GET' }).handler(async () => {
  const overrideCookie = getCookie('vercel-flag-overrides');
  return {
    govukBranded: await evaluateFlag(govukBranded, overrideCookie),
  };
});

/** Wraps getFlagState in TanStack Query so loader calls hit the client cache instead of firing a fresh RPC per navigation. 60s staleTime is the compromise — flag flips reach in-flight client sessions within a minute on next nav. */
export const flagStateQueryOptions = queryOptions({
  queryKey: ['flag-state'],
  queryFn: () => getFlagState(),
  staleTime: 60_000,
});
