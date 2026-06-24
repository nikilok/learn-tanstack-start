import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl } from '@tanstack/start-server-core';
import { checkBotId } from 'botid/server';

/**
 * Throws on a real client RPC (`/_serverFn/…`) that Vercel BotID flags as an
 * unverified bot, so a block surfaces as a retryable error rather than an empty
 * result a caller can't distinguish from a genuine miss. No-op for local dev,
 * in-process SSR/crawler loads, verified bots, and any BotID error (fail-open).
 * `checkLevel` stays unset so the dashboard toggle drives client and server
 * alike. Server-only via `createIsomorphicFn`.
 */
export const assertNotBot = createIsomorphicFn()
  .server(async () => {
    if (!import.meta.env.PROD) return;
    try {
      // Only gate genuine RPC fetches; SSR loader calls carry no challenge.
      if (!getRequestUrl().pathname.startsWith('/_serverFn/')) return;
      const { isBot, isVerifiedBot } = await checkBotId();
      if (!isBot || isVerifiedBot) return;
    } catch (error) {
      console.error('[BotID] check failed; allowing request', error);
      return;
    }
    throw new Error('Request blocked: automated traffic detected');
  })
  .client(() => {});
