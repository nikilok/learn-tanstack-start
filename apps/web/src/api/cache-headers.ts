import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl, setResponseHeader } from '@tanstack/start-server-core';

/**
 * Shared `Cache-Control` value for server-fn RPC responses — 30-day edge
 * TTL with 7-day stale-while-revalidate. Used by the long-lived, near-
 * immutable data responses (HMRC rows, Companies House profiles).
 */
export const LONG_EDGE_CACHE =
  's-maxage=2592000, stale-while-revalidate=604800';

/**
 * Attach a `Cache-Control` header to the current response only when the
 * request is a server-fn RPC invocation (`/_serverFn/…`). Prevents the
 * header from leaking onto the full SSR HTML response when the fn is
 * imported and called directly from a route loader. Compiled out of the
 * client bundle via `createIsomorphicFn`.
 */
export const setRpcCacheControl = createIsomorphicFn()
  .server((value: string) => {
    if (getRequestUrl().pathname.startsWith('/_serverFn/')) {
      setResponseHeader('Cache-Control', value);
    }
  })
  .client(() => {});
