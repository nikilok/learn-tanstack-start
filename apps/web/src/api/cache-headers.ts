import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl, setResponseHeader } from '@tanstack/react-start/server';

/**
 * Shared `Cache-Control` value for server-fn RPC responses — 30-day edge
 * TTL with 7-day stale-while-revalidate. Used by the long-lived, near-
 * immutable data responses (HMRC rows, Companies House profiles).
 */
export const LONG_EDGE_CACHE =
  's-maxage=2592000, stale-while-revalidate=604800';

/**
 * Short edge TTL for negative lookups (row not found). A missing hash can
 * come back to life (sponsor reinstated by a later ingest), so a long-cached
 * null would strand the URL — 5 minutes absorbs crawler storms without that.
 */
export const SHORT_EDGE_CACHE = 's-maxage=300, stale-while-revalidate=60';

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

/**
 * Attach a `Cache-Control` header to the current SSR document response.
 * Complement of `setRpcCacheControl` for route loaders that need to override
 * a routeRule default on specific outcomes (e.g. short-cache a 404 document).
 */
export const setSsrCacheControl = createIsomorphicFn()
  .server((value: string) => {
    setResponseHeader('Cache-Control', value);
  })
  .client(() => {});

/**
 * Attach a cache tag to the current SSR document response so the
 * `company-{number}` purge pipeline (`server/api/revalidate`) invalidates the
 * cached HTML alongside the RPC data it already tags. Server-only; no-op on the
 * client. Uses the same `x-vercel-cache-tag` header as the RPC so a single
 * `invalidateByTags` call clears both.
 */
export const setSsrCacheTag = createIsomorphicFn()
  .server((tag: string) => {
    setResponseHeader('x-vercel-cache-tag', tag);
  })
  .client(() => {});
