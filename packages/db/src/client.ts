import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

export function createClient(url: string) {
  const sql = neon(url);
  return drizzle({ client: sql });
}
