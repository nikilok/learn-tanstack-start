import { createClient } from '@ss/db/client';
import { sicCodes } from '@ss/db/schema';
import { sql } from 'drizzle-orm';
import sicCodeData from '../data/sic-codes.json';

const db = createClient(process.env.POSTGRES_URL as string);

const entries = Object.entries(sicCodeData);
console.log(`Seeding ${entries.length} SIC codes...`);

await db.execute(sql`TRUNCATE TABLE ${sicCodes}`);

const BATCH_SIZE = 500;
for (let i = 0; i < entries.length; i += BATCH_SIZE) {
  const batch = entries
    .slice(i, i + BATCH_SIZE)
    .map(([code, description]) => ({ code, description }));

  await db.insert(sicCodes).values(batch);

  console.log(
    `  Inserted ${Math.min(i + BATCH_SIZE, entries.length)}/${entries.length}`,
  );
}

console.log('Done!');
