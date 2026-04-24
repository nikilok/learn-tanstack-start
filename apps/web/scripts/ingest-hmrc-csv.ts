import { neon } from '@ss/db/client';
import { parse } from 'csv-parse/sync';
import { slugify } from '../src/utils';
import { setGitHubOutput } from './ci-utils';

const EXPECTED_COLUMNS = [
  'Organisation Name',
  'Town/City',
  'County',
  'Type & Rating',
  'Route',
] as const;

const BATCH_SIZE = 500;

const force = process.argv.includes('--force');
const url = process.argv.filter((a) => !a.startsWith('--'))[2];
if (!url) {
  console.error('Usage: bun run db:ingest <csv-url> [--force]');
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

// Step 2: Checksum comparison
const checksum = new Bun.CryptoHasher('sha256').update(csvText).digest('hex');
const [lastIngestion] =
  await sql`SELECT "checksum" FROM "hmrc_ingestion_meta" ORDER BY "ingested_at" DESC LIMIT 1`;
if (!force && lastIngestion?.checksum === checksum) {
  console.log('CSV unchanged since last ingestion — skipping.');
  setGitHubOutput('data-changed', 'false');
  process.exit(0);
}
if (force) console.log('Force flag set — skipping checksum comparison.');

// Step 3: Schema validation

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

// Step 4: Create staging table
console.log('Creating staging table...');
await sql`DROP TABLE IF EXISTS "hmrc_skilled_workers_staging"`;
await sql`
  CREATE TABLE "hmrc_skilled_workers_staging" (
    "id" serial PRIMARY KEY NOT NULL,
    "hash" varchar(11) NOT NULL UNIQUE,
    "organisation_name" varchar(255) NOT NULL,
    "name_slug" varchar(255) NOT NULL,
    "town_city" varchar(100),
    "county" varchar(100),
    "type_rating" varchar(100) NOT NULL,
    "route" varchar(100) NOT NULL
  )
`;

// Step 5: Bulk insert into staging table
console.log(
  `Inserting ${records.length} records in batches of ${BATCH_SIZE}...`,
);

function clean(val: string | undefined): string | null {
  if (!val || val === 'NULL') return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  return trimmed;
}

function computeHash(
  orgName: string,
  townCity: string | null,
  county: string | null,
  typeRating: string,
  route: string,
): string {
  const input = [orgName, townCity ?? '', county ?? '', typeRating, route].join(
    '|',
  );
  const bytes = new Bun.CryptoHasher('sha256').update(input).digest();
  // Take first 8 bytes (64 bits), encode as base64url, trim to 11 chars
  return Buffer.from(bytes.slice(0, 8)).toString('base64url').slice(0, 11);
}

// Deduplicate rows with identical content
type CleanedRow = {
  hash: string;
  orgName: string;
  nameSlug: string;
  townCity: string | null;
  county: string | null;
  typeRating: string;
  route: string;
};

const seen = new Set<string>();
const dedupedRows: CleanedRow[] = [];

for (const r of records) {
  const orgName = r['Organisation Name'].trim();
  const townCity = clean(r['Town/City']);
  const county = clean(r.County);
  const typeRating = r['Type & Rating'].trim();
  const route = r.Route.trim();
  const hash = computeHash(orgName, townCity, county, typeRating, route);
  const nameSlug = slugify(orgName) || hash;

  if (!seen.has(hash)) {
    seen.add(hash);
    dedupedRows.push({
      hash,
      orgName,
      nameSlug,
      townCity,
      county,
      typeRating,
      route,
    });
  }
}

console.log(
  `Deduplicated: ${records.length} → ${dedupedRows.length} unique records`,
);

for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
  const batch = dedupedRows.slice(i, i + BATCH_SIZE);
  const placeholders: string[] = [];
  const values: (string | null)[] = [];

  for (let j = 0; j < batch.length; j++) {
    const r = batch[j];
    const offset = j * 7;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
    );
    values.push(
      r.hash,
      r.orgName,
      r.nameSlug,
      r.townCity,
      r.county,
      r.typeRating,
      r.route,
    );
  }

  await sql.query(
    `INSERT INTO "hmrc_skilled_workers_staging" ("hash", "organisation_name", "name_slug", "town_city", "county", "type_rating", "route") VALUES ${placeholders.join(', ')}`,
    values,
  );

  console.log(
    `  Inserted ${Math.min(i + BATCH_SIZE, dedupedRows.length)}/${dedupedRows.length}`,
  );
}

// Step 6: Build indexes on staging table
console.log('Building indexes on staging table...');
await Promise.all([
  sql`CREATE INDEX "stg_idx_hmrc_org_name" ON "hmrc_skilled_workers_staging" USING btree ("organisation_name")`,
  sql`CREATE INDEX "stg_idx_hmrc_name_slug" ON "hmrc_skilled_workers_staging" USING btree ("name_slug")`,
  sql`CREATE INDEX "stg_idx_hmrc_town_city" ON "hmrc_skilled_workers_staging" USING btree ("town_city")`,
  sql`CREATE INDEX "stg_idx_hmrc_route" ON "hmrc_skilled_workers_staging" USING btree ("route")`,
  sql`CREATE INDEX "stg_idx_hmrc_org_name_trgm" ON "hmrc_skilled_workers_staging" USING gin ("organisation_name" gin_trgm_ops)`,
]);
console.log('Indexes built');

// Step 7: Atomic swap via transaction
// Drop old table first (removes its indexes), then rename staging to live
console.log('Swapping tables...');
await sql.transaction([
  sql`DROP TABLE "hmrc_skilled_workers"`,
  sql`ALTER TABLE "hmrc_skilled_workers_staging" RENAME TO "hmrc_skilled_workers"`,
  sql`ALTER INDEX "stg_idx_hmrc_org_name" RENAME TO "idx_hmrc_org_name"`,
  sql`ALTER INDEX "stg_idx_hmrc_name_slug" RENAME TO "idx_hmrc_name_slug"`,
  sql`ALTER INDEX "stg_idx_hmrc_town_city" RENAME TO "idx_hmrc_town_city"`,
  sql`ALTER INDEX "stg_idx_hmrc_route" RENAME TO "idx_hmrc_route"`,
  sql`ALTER INDEX "stg_idx_hmrc_org_name_trgm" RENAME TO "idx_hmrc_org_name_trgm"`,
  sql`ALTER INDEX "hmrc_skilled_workers_staging_hash_key" RENAME TO "hmrc_skilled_workers_hash_unique"`,
]);

// Step 8: Record ingestion metadata
await sql`INSERT INTO "hmrc_ingestion_meta" ("csv_url", "checksum", "record_count") VALUES (${url}, ${checksum}, ${dedupedRows.length})`;

console.log(`Done! Ingested ${dedupedRows.length} records with zero downtime.`);
setGitHubOutput('data-changed', 'true');
