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
// Volume floor: abort before the swap when the feed shrinks below this
// fraction of the last ingest — a truncated upload with a valid header would
// otherwise atomically gut the live table.
const MIN_RECORD_RATIO = 0.5;

const force = process.argv.includes('--force');
const allowShrink = process.argv.includes('--allow-shrink');
const url = process.argv.filter((a) => !a.startsWith('--'))[2];
if (!url) {
  console.error(
    'Usage: bun run db:ingest <csv-url> [--force] [--allow-shrink]',
  );
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
  await sql`SELECT "checksum", "record_count" FROM "hmrc_ingestion_meta" ORDER BY "ingested_at" DESC LIMIT 1`;
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
// Must agree with hmrc_skilled_workers in packages/db/src/schema.ts
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

/** Mint the stable URL id from the joined org|rating|route input. Town/county
 *  are deliberately excluded so URLs survive relocations and HMRC town edits;
 *  the ~900 feed rows that differ only by town within an org|rating|route
 *  collapse keep-first. Org renames do churn the hash (accepted — slug-only
 *  URLs are planned). Collisions are caught by the dedup loop's input
 *  recheck — the table UNIQUE(hash) can never see one, since dedup keeps
 *  duplicate hashes out of the INSERT entirely. */
function computeHash(input: string): string {
  const bytes = new Bun.CryptoHasher('sha256').update(input).digest();
  // Take first 8 bytes (64 bits), encode as base64url, trim to 11 chars
  return Buffer.from(bytes.subarray(0, 8)).toString('base64url').slice(0, 11);
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

// hash → its full input string, so a hash hit can distinguish town-variant
// duplicates (same input, keep-first) from genuine 64-bit collisions.
const seen = new Map<string, string>();
const dedupedRows: CleanedRow[] = [];
// Empty identity fields collide distinct rows into one hash, and a value
// over its varchar width aborts a 500-row INSERT mid-ingest with no row
// context. Fail fast naming the rows instead.
const invalidRows: string[] = [];

for (const [i, r] of records.entries()) {
  const rowNum = i + 2; // 1-based, after the header row
  const orgName = r['Organisation Name'].trim();
  const townCity = clean(r['Town/City']);
  const county = clean(r.County);
  const typeRating = r['Type & Rating'].trim();
  const route = r.Route.trim();

  if (!orgName || orgName.length > 255) {
    invalidRows.push(
      `row ${rowNum}: bad Organisation Name ${JSON.stringify(orgName)}`,
    );
    continue;
  }
  if (!typeRating || !route) {
    invalidRows.push(
      `row ${rowNum} ("${orgName}"): empty ${!typeRating ? 'Type & Rating' : 'Route'}`,
    );
    continue;
  }
  const oversized = [
    ['Town/City', townCity],
    ['County', county],
    ['Type & Rating', typeRating],
    ['Route', route],
  ].find(([, val]) => val && val.length > 100);
  if (oversized) {
    invalidRows.push(
      `row ${rowNum} ("${orgName}"): ${oversized[0]} exceeds 100 chars (${oversized[1]?.length})`,
    );
    continue;
  }

  // hashInput doubles as the collision-check key below, so the compared
  // string is by construction exactly what was hashed.
  const hashInput = [orgName, typeRating, route].join('|');
  const hash = computeHash(hashInput);
  // slugify can expand certain Unicode ('İ' → 'i' + combining mark → extra
  // dash), so a ≤255 org name can still overflow name_slug varchar(255).
  // The no-alphanumerics fallback must itself be a slugify FIXED POINT
  // (slug-only lookups normalise the URL through slugify first) — a raw
  // base64url hash (uppercase/underscores) would be permanently unreachable.
  const nameSlug = slugify(orgName) || slugify(`org-${hash}`);
  if (nameSlug.length > 255) {
    invalidRows.push(
      `row ${rowNum} ("${orgName}"): name_slug exceeds 255 chars (${nameSlug.length})`,
    );
    continue;
  }

  // Org name is inside the hash, so the only legitimate intra-hash variance
  // is town/county (multi-site orgs) — keep-first is the accepted policy.
  const prevInput = seen.get(hash);
  if (prevInput === undefined) {
    seen.set(hash, hashInput);
    dedupedRows.push({
      hash,
      orgName,
      nameSlug,
      townCity,
      county,
      typeRating,
      route,
    });
  } else if (prevInput !== hashInput) {
    invalidRows.push(
      `row ${rowNum} ("${orgName}"): hash ${hash} collides with a different org|rating|route`,
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

// Both sides are deduped counts: record_count stores dedupedRows.length.
// No baseline on a fresh database (no meta row) — skip.
const lastCount = lastIngestion?.record_count ?? null;
if (
  !allowShrink &&
  lastCount !== null &&
  dedupedRows.length < lastCount * MIN_RECORD_RATIO
) {
  console.error(
    `Volume floor: ${dedupedRows.length} records is under ${MIN_RECORD_RATIO * 100}% of the last ingest (${lastCount}) — refusing to swap.`,
  );
  console.error(
    '  Truncated feed? If the shrink is real, re-run with --allow-shrink.',
  );
  process.exit(1);
}

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

// Step 5.5: Disambiguate namesake slugs. Distinct legal entities whose names
// slugify identically must not share a URL: within each colliding slug, one
// company keeps the base slug and every other MAPPED company gets a stable
// `-{company_number}` suffix. Slug ownership is STICKY across ingests — a
// company that held a slug (base or suffixed) in the live table keeps it, so
// collision-set changes (keeper delisted, new namesake mapped) never flip an
// indexed URL onto a different legal entity; min(company_number) only breaks
// ties for brand-new collisions. Unmapped orgs keep the base slug and pool
// with it — mirroring the page's namesake guard in api/hmrc.ts. rtrim+left
// guard the varchar(255) cap without minting '--' (never a slugify fixed
// point). A renamed company's base slug changes, so its old suffix stops
// sticking by design — the rename fallback covers the old URL instead.
console.log('Disambiguating namesake slugs...');
const stickied = (await sql`
  WITH mapped AS (
    SELECT DISTINCT st."organisation_name", st."name_slug", m."company_number"
    FROM "hmrc_skilled_workers_staging" st
    JOIN "hmrc_company_mapping" m ON m."organisation_name" = st."organisation_name"
    WHERE m."company_number" IS NOT NULL
  ),
  prior AS (
    SELECT DISTINCT m."company_number", h."name_slug"
    FROM "hmrc_skilled_workers" h
    JOIN "hmrc_company_mapping" m ON m."organisation_name" = h."organisation_name"
    WHERE m."company_number" IS NOT NULL
  )
  UPDATE "hmrc_skilled_workers_staging" st
  SET "name_slug" = p."name_slug"
  FROM mapped mp
  JOIN prior p ON p."company_number" = mp."company_number"
  WHERE st."organisation_name" = mp."organisation_name"
    AND st."name_slug" = mp."name_slug"
    AND p."name_slug" = rtrim(left(st."name_slug", 254 - length(mp."company_number")), '-') || '-' || lower(mp."company_number")
  RETURNING st."organisation_name"
`) as { organisation_name: string }[];
const disambiguated = (await sql`
  WITH mapped AS (
    SELECT DISTINCT st."organisation_name", st."name_slug", m."company_number"
    FROM "hmrc_skilled_workers_staging" st
    JOIN "hmrc_company_mapping" m ON m."organisation_name" = st."organisation_name"
    WHERE m."company_number" IS NOT NULL
  ),
  prior AS (
    SELECT DISTINCT m."company_number", h."name_slug"
    FROM "hmrc_skilled_workers" h
    JOIN "hmrc_company_mapping" m ON m."organisation_name" = h."organisation_name"
    WHERE m."company_number" IS NOT NULL
  ),
  keepers AS (
    SELECT mp."name_slug",
           coalesce(
             -- ORDER BY, not bare LIMIT 1: when two mapped companies both
             -- count as prior holders of this slug (a namesake pooled here
             -- unmapped, then gained a mapping), an unordered pick is plan-
             -- dependent — it could hand the indexed base slug to the newcomer
             -- and exile the incumbent, and even differ between a dry run and
             -- the real run. Lowest company number is stable and matches the
             -- new-collision tie-break below.
             (SELECT p."company_number"
              FROM prior p
              JOIN mapped mp2 ON mp2."company_number" = p."company_number"
                             AND mp2."name_slug" = mp."name_slug"
              WHERE p."name_slug" = mp."name_slug"
              ORDER BY p."company_number" ASC
              LIMIT 1),
             min(mp."company_number")
           ) AS keeper
    FROM mapped mp
    GROUP BY mp."name_slug"
    HAVING count(DISTINCT mp."company_number") > 1
  )
  UPDATE "hmrc_skilled_workers_staging" st
  SET "name_slug" = rtrim(left(st."name_slug", 254 - length(mp."company_number")), '-') || '-' || lower(mp."company_number")
  FROM mapped mp
  JOIN keepers k ON k."name_slug" = mp."name_slug"
  WHERE st."organisation_name" = mp."organisation_name"
    AND st."name_slug" = mp."name_slug"
    AND mp."company_number" <> k."keeper"
  RETURNING st."organisation_name"
`) as { organisation_name: string }[];
console.log(
  `  ${stickied.length} prior suffixes re-applied, ${disambiguated.length} rows newly suffixed`,
);

// Step 6: Build indexes on staging table
console.log('Building indexes on staging table...');
await Promise.all([
  sql`CREATE INDEX "stg_idx_hmrc_org_name" ON "hmrc_skilled_workers_staging" USING btree ("organisation_name")`,
  sql`CREATE INDEX "stg_idx_hmrc_name_slug" ON "hmrc_skilled_workers_staging" USING btree ("name_slug")`,
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
  sql`ALTER INDEX "stg_idx_hmrc_route" RENAME TO "idx_hmrc_route"`,
  sql`ALTER INDEX "stg_idx_hmrc_org_name_trgm" RENAME TO "idx_hmrc_org_name_trgm"`,
  sql`ALTER INDEX "hmrc_skilled_workers_staging_hash_key" RENAME TO "hmrc_skilled_workers_hash_unique"`,
]);

// Step 8: Seed mapping stubs for orgs new to the register. verified_at NULL
// sorts them to the FRONT of the nightly phase5 no_match sweep (NULLS FIRST),
// so every new sponsor is resolved within a day instead of waiting for a page
// visit to trigger the on-demand resolver. ON CONFLICT keeps this idempotent
// and never touches existing mappings.
console.log('Seeding mapping stubs for new organisations...');
const stubbed = (await sql`
  INSERT INTO "hmrc_company_mapping" ("organisation_name", "match_method")
  SELECT DISTINCT w."organisation_name", 'no_match'
  FROM "hmrc_skilled_workers" w
  LEFT JOIN "hmrc_company_mapping" m ON m."organisation_name" = w."organisation_name"
  WHERE m."organisation_name" IS NULL
  ON CONFLICT ("organisation_name") DO NOTHING
  RETURNING "organisation_name"
`) as { organisation_name: string }[];
console.log(`  ${stubbed.length} new mapping stubs seeded`);

// Step 9: Record ingestion metadata
await sql`INSERT INTO "hmrc_ingestion_meta" ("csv_url", "checksum", "record_count") VALUES (${url}, ${checksum}, ${dedupedRows.length})`;

console.log(`Done! Ingested ${dedupedRows.length} records with zero downtime.`);
setGitHubOutput('data-changed', 'true');
