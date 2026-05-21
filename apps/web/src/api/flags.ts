import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';
import { evaluateFlag, govukBranded } from '../flags.server';

/** Evaluates every declared flag for the current request and returns the resolved values. Route loaders call this so the values are baked into SSR HTML — no client-side fetch, no flicker. */
export const getFlagState = createServerFn({ method: 'GET' }).handler(
  async () => {
    const overrideCookie = getCookie('vercel-flag-overrides');
    return {
      govukBranded: await evaluateFlag(govukBranded, overrideCookie),
    };
  },
);
