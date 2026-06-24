import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl } from '@tanstack/start-server-core';
import { checkBotId } from 'botid/server';

/**
 * Resolves true when the current request is a real client RPC (`/_serverFn/…`)
 * that Vercel BotID classifies as an unverified bot — the signal to deny it.
 * Returns false (allow) in local dev (BotID activates on deployed builds only),
 * for in-process SSR loader calls (no client challenge
 * exists at first paint, so checking them would flag crawlers and break the
 * server-rendered HTML), for verified bots (Googlebot et al.), and for any
 * BotID/runtime error — fail-open so an integration hiccup never blocks real
 * users. `checkLevel` is intentionally unset so the Vercel dashboard toggle
 * (Basic vs Deep Analysis) drives client and server identically. Server logic
 * is compiled out of the client bundle via `createIsomorphicFn`.
 */
export const isBlockedBot = createIsomorphicFn()
  .server(async () => {
    // Deployed builds only — the client challenge is PROD-gated too, so calling checkBotId in local dev just logs a misconfig warning before bypassing.
    if (!import.meta.env.PROD) return false;
    // Skip the in-process SSR path; only gate genuine RPC fetches.
    if (!getRequestUrl().pathname.startsWith('/_serverFn/')) return false;
    try {
      const { isBot, isVerifiedBot } = await checkBotId();
      return isBot && !isVerifiedBot;
    } catch (error) {
      console.error('[BotID] check failed; allowing request', error);
      return false;
    }
  })
  .client(() => false);
