import { createServerFn } from '@tanstack/react-start';

/**
 * Server fn that logs a client-side route error to the server console. Used
 * by route `errorComponent`s to surface browser crashes in Vercel logs.
 */
export const logError = createServerFn()
  .inputValidator(
    (input: unknown) => input as { message: string; stack?: string },
  )
  .handler(async ({ data: { message, stack } }) => {
    console.error('[RouteError]', message);
    if (stack) console.error(stack);
  });
