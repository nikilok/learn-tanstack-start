import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { posts } from './schema';

const sql = neon(process.env.POSTGRES_URL!);
const db = drizzle({ client: sql });

async function seed() {
  console.log('Seeding database...');

  await db.insert(posts).values([
    { title: 'Getting started with TanStack Start', author: 'Alice', published: true },
    { title: 'Server functions deep dive', author: 'Bob', published: true },
    { title: 'Deploying to Vercel', author: 'Charlie', published: false },
  ]);

  console.log('Seeded 3 posts.');
}

seed();
