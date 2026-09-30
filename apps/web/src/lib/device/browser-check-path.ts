/**
 * The fixed path Vercel BotID's client loads its challenge from, and under which the
 * challenge makes every call of its own (see `botid/nuxt`). The Nitro route rules proxy it
 * to Vercel (vite.config.ts), and the edge middleware passes it through untouched
 * (middleware.ts): one value for both, since a call the middleware answers never reaches
 * the proxy, and the challenge then cannot complete.
 */
export const BROWSER_CHECK_PATH =
  '/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3';
