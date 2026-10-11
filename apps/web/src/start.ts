import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from '@tanstack/react-start';

import { setRpcCacheControl } from './api/cache-headers';
import { clientSafeError, failureLogLine } from './lib/server-fn-errors';
import { sessionFetch } from './lib/session/client';

/** Logs a failed server function in one line, marks its RPC response `private, no-store`, and hands the caller `clientSafeError`'s replacement. */
const serverFnErrors = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    try {
      return await next();
    } catch (error) {
      const safe = clientSafeError(error);
      if (safe !== error) {
        console.error(failureLogLine(serverFnMeta.name, error));
        // A failed RPC still answers 200, so a Cache-Control set before the throw would stand.
        setRpcCacheControl('private, no-store');
      }
      throw safe;
    }
  },
);

/** Start options. Declaring a start instance drops the framework's default request middleware, so the server-function CSRF check is registered here. In the browser every server function call goes through the session's fetch, which renews the session and calls again when a call is refused for want of one. */
export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' }),
  ],
  functionMiddleware: [serverFnErrors],
  serverFns: { fetch: sessionFetch },
}));
