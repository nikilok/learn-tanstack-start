import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

export { neon } from '@neondatabase/serverless';

/**
 * Build a Drizzle client backed by Neon's serverless HTTP driver. The returned
 * instance is safe for one-shot queries in edge/serverless handlers and does
 * not hold a persistent connection.
 */
export function createClient(url: string) {
  const sql = neon(url);
  return drizzle({ client: sql });
}
