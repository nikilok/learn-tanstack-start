import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

/** The current request's path as the server reads it (escapes already decoded, case kept), or null in the browser. */
export const requestPathname = createIsomorphicFn()
  .server((): string | null => new URL(getRequest().url).pathname)
  .client((): string | null => null);
