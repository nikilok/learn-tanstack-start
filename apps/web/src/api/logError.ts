import { createServerFn } from '@tanstack/react-start';

export const logError = createServerFn()
  .inputValidator(
    (input: unknown) => input as { message: string; stack?: string },
  )
  .handler(async ({ data: { message, stack } }) => {
    console.error('[RouteError]', message);
    if (stack) console.error(stack);
  });
