import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';

const migrationsFolder = join(import.meta.dirname, '..', 'migrations');

export async function runMigrations(url: string) {
  const sql = neon(url);
  const db = drizzle({ client: sql });
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete.');
}
