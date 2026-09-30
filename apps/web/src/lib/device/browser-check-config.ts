/**
 * What every side of the browser check (Vercel BotID) must agree on, in one place.
 */

/**
 * The fixed path BotID's client loads its challenge from, and under which the challenge makes
 * every call of its own (see `botid/nuxt`). The Nitro route rules proxy it to Vercel
 * (vite.config.ts), and the edge middleware passes it through untouched (middleware.ts): a call
 * the middleware answers never reaches the proxy, and the challenge then cannot complete.
 */
export const BROWSER_CHECK_PATH =
  '/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3';

/**
 * The level the check runs at, named on the client's protected calls and in the server's check
 * alike. BotID requires the two to match: a client left at Basic sends none of the data Deep
 * Analysis reads, and the server's check then names every visitor automated.
 */
export const BROWSER_CHECK_LEVEL = 'deepAnalysis' as const;
