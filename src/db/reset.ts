import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.POSTGRES_URL as string);

async function reset() {
  console.log('Dropping tables...');
  await sql`DROP TABLE IF EXISTS posts`;
  await sql`DROP TABLE IF EXISTS "__drizzle_migrations"`;
  console.log('Done. Run db:migrate to rebuild.');
}

reset();
