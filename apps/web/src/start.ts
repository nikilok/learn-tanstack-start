import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from '@tanstack/react-start';

import { clientSafeError, failureLogLine } from './lib/server-fn-errors';

/** Logs a failed server function in one line and hands the caller `clientSafeError`'s replacement. */
const serverFnErrors = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    try {
      return await next();
    } catch (error) {
      const safe = clientSafeError(error);
      if (safe !== error) {
        console.error(failureLogLine(serverFnMeta.name, error));
      }
      throw safe;
    }
  },
);

/** Start options. Declaring a start instance drops the framework's default request middleware, so the server-function CSRF check is registered here. */
export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' }),
  ],
  functionMiddleware: [serverFnErrors],
}));
