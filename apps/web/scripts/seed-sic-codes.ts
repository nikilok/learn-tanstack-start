import { neon } from '@neondatabase/serverless';
import sicCodes from '../data/sic-codes.json';

const sql = neon(process.env.POSTGRES_URL as string);

const entries = Object.entries(sicCodes);
console.log(`Seeding ${entries.length} SIC codes...`);

await sql`TRUNCATE TABLE "sic_codes"`;

const BATCH_SIZE = 500;
for (let i = 0; i < entries.length; i += BATCH_SIZE) {
  const batch = entries.slice(i, i + BATCH_SIZE);
  const placeholders: string[] = [];
  const values: string[] = [];

  for (let j = 0; j < batch.length; j++) {
    const offset = j * 2;
    placeholders.push(`($${offset + 1}, $${offset + 2})`);
    values.push(batch[j][0], batch[j][1]);
  }

  await sql.query(
    `INSERT INTO "sic_codes" ("code", "description") VALUES ${placeholders.join(', ')}`,
    values,
  );

  console.log(
    `  Inserted ${Math.min(i + BATCH_SIZE, entries.length)}/${entries.length}`,
  );
}

console.log('Done!');
