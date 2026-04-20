import { createClient } from '@ss/db';

/**
 * Shared Drizzle client bound to the Neon `POSTGRES_URL`. Import this from
 * server-only code paths (server fns, Nitro routes) — the `.server.ts`
 * suffix prevents accidental client bundling.
 */
export const db = createClient(process.env.POSTGRES_URL as string);
