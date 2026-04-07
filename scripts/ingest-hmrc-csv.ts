import { neon } from '@neondatabase/serverless';
import { parse } from 'csv-parse/sync';

const EXPECTED_COLUMNS = [
  'Organisation Name',
  'Town/City',
  'County',
  'Type & Rating',
  'Route',
] as const;

const BATCH_SIZE = 500;

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun run db:ingest <csv-url>');
  process.exit(1);
}

const sql = neon(process.env.POSTGRES_URL as string);

// Step 1: Download CSV
console.log(`Downloading CSV from ${url}...`);
const response = await fetch(url);
if (!response.ok) {
  console.error(
    `Failed to download CSV: ${response.status} ${response.statusText}`,
  );
  process.exit(1);
}
const csvText = await response.text();
console.log(`Downloaded ${(csvText.length / 1024).toFixed(1)} KB`);

// Step 2: Schema validation
const records: Array<Record<string, string>> = parse(csvText, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

if (records.length === 0) {
  console.error('CSV contains no data rows');
  process.exit(1);
}

const actualColumns = Object.keys(records[0]);
const missingColumns = EXPECTED_COLUMNS.filter(
  (col) => !actualColumns.includes(col),
);
const extraColumns = actualColumns.filter(
  (col) => !EXPECTED_COLUMNS.includes(col as (typeof EXPECTED_COLUMNS)[number]),
);

if (missingColumns.length > 0 || extraColumns.length > 0) {
  console.error('Schema mismatch detected!');
  if (missingColumns.length > 0) {
    console.error(`  Missing columns: ${missingColumns.join(', ')}`);
  }
  if (extraColumns.length > 0) {
    console.error(`  Unexpected columns: ${extraColumns.join(', ')}`);
  }
  console.error(`  Expected: ${EXPECTED_COLUMNS.join(', ')}`);
  console.error(`  Received: ${actualColumns.join(', ')}`);
  process.exit(1);
}

console.log(`Validated schema: ${records.length} records found`);

// Step 3: Create staging table
console.log('Creating staging table...');
await sql`DROP TABLE IF EXISTS "hmrc_skilled_workers_staging"`;
await sql`
  CREATE TABLE "hmrc_skilled_workers_staging" (
    "id" serial PRIMARY KEY NOT NULL,
    "organisation_name" varchar(255) NOT NULL,
    "town_city" varchar(100),
    "county" varchar(100),
    "type_rating" varchar(100) NOT NULL,
    "route" varchar(100) NOT NULL
  )
`;

// Step 4: Bulk insert into staging table
console.log(
  `Inserting ${records.length} records in batches of ${BATCH_SIZE}...`,
);

function clean(val: string | undefined): string | null {
  if (!val || val === 'NULL') return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  return trimmed;
}

for (let i = 0; i < records.length; i += BATCH_SIZE) {
  const batch = records.slice(i, i + BATCH_SIZE);
  const placeholders: string[] = [];
  const values: (string | null)[] = [];

  for (let j = 0; j < batch.length; j++) {
    const r = batch[j];
    const offset = j * 5;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`,
    );
    values.push(
      r['Organisation Name'].trim(),
      clean(r['Town/City']),
      clean(r.County),
      r['Type & Rating'].trim(),
      r.Route.trim(),
    );
  }

  await sql.query(
    `INSERT INTO "hmrc_skilled_workers_staging" ("organisation_name", "town_city", "county", "type_rating", "route") VALUES ${placeholders.join(', ')}`,
    values,
  );

  console.log(
    `  Inserted ${Math.min(i + BATCH_SIZE, records.length)}/${records.length}`,
  );
}

// Step 5: Build indexes on staging table
console.log('Building indexes on staging table...');
await Promise.all([
  sql`CREATE INDEX "stg_idx_hmrc_org_name" ON "hmrc_skilled_workers_staging" USING btree ("organisation_name")`,
  sql`CREATE INDEX "stg_idx_hmrc_town_city" ON "hmrc_skilled_workers_staging" USING btree ("town_city")`,
  sql`CREATE INDEX "stg_idx_hmrc_route" ON "hmrc_skilled_workers_staging" USING btree ("route")`,
  sql`CREATE INDEX "stg_idx_hmrc_org_name_trgm" ON "hmrc_skilled_workers_staging" USING gin ("organisation_name" gin_trgm_ops)`,
]);
console.log('Indexes built');

// Step 6: Atomic swap via transaction
// Drop old table first (removes its indexes), then rename staging to live
console.log('Swapping tables...');
await sql.transaction([
  sql`DROP TABLE "hmrc_skilled_workers"`,
  sql`ALTER TABLE "hmrc_skilled_workers_staging" RENAME TO "hmrc_skilled_workers"`,
  sql`ALTER INDEX "stg_idx_hmrc_org_name" RENAME TO "idx_hmrc_org_name"`,
  sql`ALTER INDEX "stg_idx_hmrc_town_city" RENAME TO "idx_hmrc_town_city"`,
  sql`ALTER INDEX "stg_idx_hmrc_route" RENAME TO "idx_hmrc_route"`,
  sql`ALTER INDEX "stg_idx_hmrc_org_name_trgm" RENAME TO "idx_hmrc_org_name_trgm"`,
]);

console.log(`Done! Ingested ${records.length} records with zero downtime.`);
