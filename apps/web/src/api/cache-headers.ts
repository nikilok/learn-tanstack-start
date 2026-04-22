import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl, setResponseHeader } from '@tanstack/start-server-core';

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
