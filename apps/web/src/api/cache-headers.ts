import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl, setResponseHeader } from '@tanstack/react-start/server';

import { ALL_COMPANY_PAGES_TAG, companyCacheTagHeader } from './cache-tags';

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
 * Minimal edge TTL for transient-failure responses (upstream refused or
 * returned nothing usable). Long enough to absorb a same-page refetch
 * burst, short enough that recovery is never pinned behind a cached
 * failure.
 */
export const TRANSIENT_EDGE_CACHE = 's-maxage=60';

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
 * Attach a cache tag to the current response — SSR document or RPC alike — so
 * the purge pipelines (`server/api/revalidate`, release publishing) invalidate
 * every response carrying the tag with a single `invalidateByTags` call.
 * Server-only; no-op on the client. The sole spelling of the
 * `x-vercel-cache-tag` header.
 */
export const setCacheTag = createIsomorphicFn()
  .server((tag: string) => {
    setResponseHeader('x-vercel-cache-tag', tag);
  })
  .client(() => {});

/**
 * Tag a company-scoped response with the population-wide `company-pages` tag —
 * plus its own `company-{number}` tag when the number is known — in one header
 * write: setResponseHeader overwrites, so two setCacheTag calls would silently
 * drop the first tag. Every long-cached company SSR document and RPC must use
 * this, never a bare setCacheTag, or the nightly post-sweep purge cannot reach
 * that response.
 */
export function setCompanyCacheTag(companyNumber?: string): void {
  setCacheTag(
    companyNumber
      ? companyCacheTagHeader(companyNumber)
      : ALL_COMPANY_PAGES_TAG,
  );
}
