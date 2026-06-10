import { neon } from '@ss/db/client';
import { parse } from 'csv-parse/sync';

import { slugify } from '../src/utils';
import { setGitHubOutput } from './ci-utils';

const EXPECTED_COLUMNS = [
  'Sponsor Licence Number',
  'Organisation Name',
  'TierRating',
  'Migrant Classification',
  'Sponsor Status',
] as const;

const BATCH_SIZE = 500;
// Must agree with sponsor_licence_number varchar(64) in packages/db/src/schema.ts
const LICENCE_MAX_LEN = 64;

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
// sql.query (not the tagged template): DDL can't take $n params, and the
// licence width interpolates from LICENCE_MAX_LEN so DDL and guard can't drift
await sql.query(`
  CREATE TABLE "hmrc_skilled_workers_staging" (
    "id" serial PRIMARY KEY NOT NULL,
    "hash" varchar(11) NOT NULL UNIQUE,
    "organisation_name" varchar(255) NOT NULL,
    "name_slug" varchar(255) NOT NULL,
    "sponsor_licence_number" varchar(${LICENCE_MAX_LEN}),
    "sponsor_status" varchar(64),
    "type_rating" varchar(100) NOT NULL,
    "route" varchar(100) NOT NULL
  )
`);

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

/** Mint the stable URL id from the licence-based row identity. Licence is a
 *  durable per-sponsor key, so hashes survive company renames and future
 *  ingests — org name is deliberately excluded. */
function computeHash(
  licence: string,
  typeRating: string,
  route: string,
): string {
  const input = [licence, typeRating, route].join('|');
  const bytes = new Bun.CryptoHasher('sha256').update(input).digest();
  // Take first 8 bytes (64 bits), encode as base64url, trim to 11 chars
  return Buffer.from(bytes.slice(0, 8)).toString('base64url').slice(0, 11);
}

// Deduplicate rows with identical content
type CleanedRow = {
  hash: string;
  orgName: string;
  nameSlug: string;
  licence: string;
  status: string | null;
  typeRating: string;
  route: string;
};

const seen = new Map<string, CleanedRow>();
const dedupedRows: CleanedRow[] = [];
// Licence is the hash backbone: blank values collide distinct orgs into one
// hash (silently dropped by dedup), and >20 chars aborts the batched INSERT
// mid-ingest with no row context. Fail fast naming the rows instead.
const invalidRows: string[] = [];

for (const [i, r] of records.entries()) {
  const rowNum = i + 2; // 1-based, after the header row
  const licence = r['Sponsor Licence Number'].trim();
  const orgName = r['Organisation Name'].trim();
  const typeRating = r.TierRating.trim();
  const route = r['Migrant Classification'].trim();
  const status = clean(r['Sponsor Status']);

  if (!licence || licence.length > LICENCE_MAX_LEN) {
    invalidRows.push(
      `row ${rowNum} ("${orgName || '?'}"): bad Sponsor Licence Number ${JSON.stringify(licence)}`,
    );
    continue;
  }
  if (status && status.length > 64) {
    invalidRows.push(
      `row ${rowNum} ("${orgName}"): Sponsor Status exceeds 64 chars (${status.length})`,
    );
    continue;
  }

  const hash = computeHash(licence, typeRating, route);
  const nameSlug = slugify(orgName) || hash;

  const previous = seen.get(hash);
  if (!previous) {
    const row: CleanedRow = {
      hash,
      orgName,
      nameSlug,
      licence,
      status,
      typeRating,
      route,
    };
    seen.set(hash, row);
    dedupedRows.push(row);
  } else if (previous.orgName !== orgName || previous.status !== status) {
    // Same licence|rating|route with a different identity: keeping either row
    // picks an arbitrary name (and therefore CH mapping). Upstream anomaly.
    invalidRows.push(
      `row ${rowNum} ("${orgName}"): conflicts with earlier "${previous.orgName}" sharing licence|rating|route (${hash})`,
    );
  }
}

if (invalidRows.length > 0) {
  console.error(`Row validation failed for ${invalidRows.length} row(s):`);
  for (const line of invalidRows.slice(0, 10)) console.error(`  ${line}`);
  if (invalidRows.length > 10) {
    console.error(`  …and ${invalidRows.length - 10} more`);
  }
  process.exit(1);
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
      r.licence,
      r.status,
      r.typeRating,
      r.route,
    );
  }

  await sql.query(
    `INSERT INTO "hmrc_skilled_workers_staging" ("hash", "organisation_name", "name_slug", "sponsor_licence_number", "sponsor_status", "type_rating", "route") VALUES ${placeholders.join(', ')}`,
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
  sql`CREATE INDEX "stg_idx_hmrc_licence" ON "hmrc_skilled_workers_staging" USING btree ("sponsor_licence_number")`,
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
  sql`ALTER INDEX "stg_idx_hmrc_licence" RENAME TO "idx_hmrc_licence"`,
  sql`ALTER INDEX "stg_idx_hmrc_route" RENAME TO "idx_hmrc_route"`,
  sql`ALTER INDEX "stg_idx_hmrc_org_name_trgm" RENAME TO "idx_hmrc_org_name_trgm"`,
  sql`ALTER INDEX "hmrc_skilled_workers_staging_hash_key" RENAME TO "hmrc_skilled_workers_hash_unique"`,
]);

// Step 8: Record ingestion metadata
await sql`INSERT INTO "hmrc_ingestion_meta" ("csv_url", "checksum", "record_count") VALUES (${url}, ${checksum}, ${dedupedRows.length})`;

console.log(`Done! Ingested ${dedupedRows.length} records with zero downtime.`);
setGitHubOutput('data-changed', 'true');
