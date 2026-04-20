import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';

const migrationsFolder = join(import.meta.dirname, '..', 'migrations');

/**
 * Apply any pending Drizzle migrations from `packages/db/migrations` against
 * the given Postgres URL using the Neon HTTP driver. Logs progress to stdout
 * and resolves once the migration run completes.
 */
export async function runMigrations(url: string) {
  const sql = neon(url);
  const db = drizzle({ client: sql });
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete.');
}
