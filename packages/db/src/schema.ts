import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const hmrcSkilledWorkers = pgTable(
  'hmrc_skilled_workers',
  {
    id: serial('id').primaryKey(),
    hash: varchar('hash', { length: 11 }).notNull().unique(),
    organisationName: varchar('organisation_name', { length: 255 }).notNull(),
    nameSlug: varchar('name_slug', { length: 255 }).notNull(),
    townCity: varchar('town_city', { length: 100 }),
    county: varchar('county', { length: 100 }),
    typeRating: varchar('type_rating', { length: 100 }).notNull(),
    route: varchar('route', { length: 100 }).notNull(),
  },
  (table) => [
    index('idx_hmrc_org_name').on(table.organisationName),
    index('idx_hmrc_name_slug').on(table.nameSlug),
    index('idx_hmrc_route').on(table.route),
    index('idx_hmrc_org_name_trgm').using(
      'gin',
      sql`${table.organisationName} gin_trgm_ops`,
    ),
  ],
);

// Snapshot of the org→licence mapping from the 2026-06-09 feed era, taken by
// migration 0030 before the post-revert ingest swap destroyed the source
// columns. Not read by the app yet — preserved for later use.
export const hmrcSponsorLicences = pgTable(
  'hmrc_sponsor_licences',
  {
    id: serial('id').primaryKey(),
    organisationName: varchar('organisation_name', { length: 255 }).notNull(),
    sponsorLicenceNumber: varchar('sponsor_licence_number', {
      length: 64,
    }).notNull(),
    typeRating: varchar('type_rating', { length: 100 }).notNull(),
    route: varchar('route', { length: 100 }).notNull(),
    sponsorStatus: varchar('sponsor_status', { length: 64 }),
    snapshottedAt: timestamp('snapshotted_at').defaultNow().notNull(),
  },
  (table) => [index('idx_sponsor_licences_org').on(table.organisationName)],
);

export const sicCodes = pgTable('sic_codes', {
  code: varchar('code', { length: 10 }).primaryKey(),
  description: text('description').notNull(),
});

export const companiesHouseProfiles = pgTable(
  'companies_house_profiles',
  {
    companyNumber: varchar('company_number', { length: 20 }).primaryKey(),
    companyName: varchar('company_name', { length: 255 }).notNull(),
    companyStatus: varchar('company_status', { length: 50 }),
    companyType: varchar('company_type', { length: 100 }),
    dateOfCreation: date('date_of_creation'),
    addressLine1: varchar('address_line_1', { length: 255 }),
    addressLine2: varchar('address_line_2', { length: 255 }),
    locality: varchar('locality', { length: 100 }),
    region: varchar('region', { length: 100 }),
    postalCode: varchar('postal_code', { length: 20 }),
    country: varchar('country', { length: 100 }),
    sicCodes: text('sic_codes')
      .array()
      .default(sql`'{}'::text[]`),
    accountsNextMadeUpTo: date('accounts_next_made_up_to'),
    accountsLastMadeUpTo: date('accounts_last_made_up_to'),
    accountsOverdue: boolean('accounts_overdue'),
    jurisdiction: varchar('jurisdiction', { length: 100 }),
    hasBeenLiquidated: boolean('has_been_liquidated'),
    hasInsolvencyHistory: boolean('has_insolvency_history'),
    hasCharges: boolean('has_charges'),
    previousCompanyNames: text('previous_company_names')
      .array()
      .default(sql`'{}'::text[]`),
    confirmationStatementLastMadeUpTo: date(
      'confirmation_statement_last_made_up_to',
    ),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_ch_company_name').on(table.companyName),
    index('idx_ch_company_status').on(table.companyStatus),
    index('idx_ch_company_type').on(table.companyType),
    index('idx_ch_sic_codes').using('gin', table.sicCodes),
    index('idx_ch_jurisdiction').on(table.jurisdiction),
    index('idx_ch_previous_names').using('gin', table.previousCompanyNames),
  ],
);

// Flattened projection of companies_house_profiles.previous_company_names so
// the search can trigram-match previous names (GIN can't index inside arrays).
// Kept in sync by the DB trigger trg_sync_ch_previous_names — do not write to
// this table from application code.
export const chPreviousNames = pgTable(
  'ch_previous_names',
  {
    companyNumber: varchar('company_number', { length: 20 })
      .notNull()
      .references(() => companiesHouseProfiles.companyNumber, {
        onDelete: 'cascade',
      }),
    name: text('name').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.companyNumber, table.name] }),
    index('idx_ch_prev_names_trgm').using(
      'gin',
      sql`${table.name} gin_trgm_ops`,
    ),
  ],
);

export const hmrcCompanyMapping = pgTable(
  'hmrc_company_mapping',
  {
    organisationName: text('organisation_name').primaryKey(),
    companyNumber: varchar('company_number', { length: 20 }),
    isPublicBody: boolean('is_public_body').notNull().default(false),
    matchMethod: varchar('match_method', { length: 32 }),
    matchScore: numeric('match_score', { precision: 4, scale: 3 }),
    queryUsed: text('query_used'),
    verifiedAt: timestamp('verified_at'),
  },
  (table) => [
    index('idx_mapping_method_verified').on(
      table.matchMethod,
      table.verifiedAt.asc().nullsFirst(),
    ),
    index('idx_mapping_company_number').on(table.companyNumber),
  ],
);

export const hmrcCompanyMappingAudit = pgTable('hmrc_company_mapping_audit', {
  id: serial('id').primaryKey(),
  organisationName: text('organisation_name').notNull(),
  oldCompanyNumber: varchar('old_company_number', { length: 20 }),
  newCompanyNumber: varchar('new_company_number', { length: 20 }),
  oldMatchMethod: varchar('old_match_method', { length: 32 }),
  newMatchMethod: varchar('new_match_method', { length: 32 }),
  changedAt: timestamp('changed_at').defaultNow().notNull(),
  changedBy: varchar('changed_by', { length: 100 }),
});

export const hmrcCompanyMappingReviewQueue = pgTable(
  'hmrc_company_mapping_review_queue',
  {
    id: serial('id').primaryKey(),
    organisationName: text('organisation_name').notNull(),
    reason: varchar('reason', { length: 40 }).notNull(),
    existingCompanyNumber: varchar('existing_company_number', { length: 20 }),
    existingMatchMethod: varchar('existing_match_method', { length: 32 }),
    existingMatchScore: numeric('existing_match_score', {
      precision: 4,
      scale: 3,
    }),
    proposedCompanyNumber: varchar('proposed_company_number', { length: 20 }),
    proposedMatchMethod: varchar('proposed_match_method', { length: 32 }),
    proposedMatchScore: numeric('proposed_match_score', {
      precision: 4,
      scale: 3,
    }),
    proposedQueryUsed: text('proposed_query_used'),
    chSearchResultsTop5: jsonb('ch_search_results_top5'),
    detectedBy: varchar('detected_by', { length: 100 }).notNull(),
    detectedAt: timestamp('detected_at').defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: varchar('resolved_by', { length: 100 }),
    resolution: varchar('resolution', { length: 40 }),
  },
  (table) => [
    index('idx_review_queue_unresolved')
      .on(table.detectedAt)
      .where(sql`${table.resolvedAt} IS NULL`),
    index('idx_review_queue_org').on(table.organisationName),
    // Partial unique index — guarantees at-most-one unresolved row per
    // (organisation_name, reason) pair. Closes the race window between
    // concurrent enqueueReview calls; lets sql.ts use ON CONFLICT DO NOTHING
    // for atomic deduplication. (CodeRabbit PR #85, comment 5.)
    uniqueIndex('ux_review_queue_unresolved_org_reason')
      .on(table.organisationName, table.reason)
      .where(sql`${table.resolvedAt} IS NULL`),
  ],
);

export const hmrcIngestionMeta = pgTable('hmrc_ingestion_meta', {
  id: serial('id').primaryKey(),
  csvUrl: text('csv_url').notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  recordCount: integer('record_count').notNull(),
  ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
});

export const companiesHouseProfileTrails = pgTable(
  'companies_house_profile_trails',
  {
    id: serial('id').primaryKey(),
    companyNumber: varchar('company_number', { length: 20 }).notNull(),
    columnName: varchar('column_name', { length: 100 }).notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // CH event time from the stream; null on rows written before 2026-07.
    publishedAt: timestamp('published_at'),
  },
  (table) => [
    index('idx_ch_trail_company_number').on(table.companyNumber),
    index('idx_ch_trail_created_at').on(table.createdAt),
  ],
);

export const companiesHouseProfileCache = pgTable(
  'companies_house_profile_cache',
  {
    key: varchar('key', { length: 50 }).primaryKey(),
    lastTrailId: integer('last_trail_id').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
);

export const chStreamState = pgTable('ch_stream_state', {
  key: varchar('key', { length: 50 }).primaryKey(),
  lastTimepoint: integer('last_timepoint'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Desktop app release registry — one row per published version. Written by the
// release workflow via POST /api/releases; read by the /download page.
export const desktopReleases = pgTable('desktop_releases', {
  id: serial('id').primaryKey(),
  version: varchar('version', { length: 32 }).notNull().unique(),
  channel: varchar('channel', { length: 16 }).notNull().default('stable'),
  notes: text('notes'),
  // 'private' (default — fail closed: new dispatches are born hidden) | 'public'.
  // Flipped by the owner-only publish action on /download, never by the workflow.
  visibility: varchar('visibility', { length: 16 })
    .notNull()
    .default('private'),
  publishedAt: timestamp('published_at').defaultNow().notNull(),
});

// One downloadable installer variant per row (platform × arch × format × install
// scope). Updater-only zip/yml/blockmap artifacts are NOT stored here — only
// user-facing downloads. The page derives its label from these columns.
export const desktopReleaseAssets = pgTable(
  'desktop_release_assets',
  {
    id: serial('id').primaryKey(),
    releaseId: integer('release_id')
      .notNull()
      .references(() => desktopReleases.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 16 }).notNull(),
    arch: varchar('arch', { length: 16 }).notNull(),
    format: varchar('format', { length: 16 }).notNull(),
    installScope: varchar('install_scope', { length: 16 })
      .notNull()
      .default(''),
    guid: varchar('guid', { length: 32 }).notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    url: text('url').notNull(),
    size: integer('size'),
    sha512: varchar('sha512', { length: 128 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('ux_desktop_asset_variant').on(
      table.releaseId,
      table.platform,
      table.arch,
      table.format,
      table.installScope,
    ),
    index('idx_desktop_asset_guid').on(table.guid),
  ],
);

// Per-download analytics — AGGREGATED counters, one row per
// (version, platform, arch, format, install_scope, country, day) bucket. The
// download route UPSERTs and increments `count` (fire-and-forget), so a
// curl-loop on a public installer URL inflates a counter, not the row count:
// the table is bounded to the finite bucket space regardless of request volume
// (defends the unauthenticated insert-amplification vector). Counts link
// *initiations*, not completed downloads. Updater-feed hits (latest/) are not
// logged. Day is the UTC calendar day.
export const desktopDownloads = pgTable(
  'desktop_downloads',
  {
    version: varchar('version', { length: 32 }).notNull(),
    platform: varchar('platform', { length: 16 }).notNull(),
    // Dimension columns are NOT NULL (default '') so a missing value keys the
    // composite PK as one bucket — a NULL would read as distinct and defeat the
    // UPSERT dedup, reopening unbounded row growth.
    arch: varchar('arch', { length: 16 }).notNull().default(''),
    format: varchar('format', { length: 16 }).notNull().default(''),
    installScope: varchar('install_scope', { length: 16 })
      .notNull()
      .default(''),
    country: varchar('country', { length: 2 }).notNull().default(''),
    day: date('day').notNull(),
    // bigint (not int4): one day's bucket can absorb the full request volume the
    // amplification vector throws at it; int4 count would overflow at ~2.1e9.
    count: bigint('count', { mode: 'number' }).notNull().default(0),
  },
  // The natural bucket tuple IS the primary key — no surrogate `id serial`, whose
  // sequence advances one-per-UPSERT-attempt and would overflow int4 under
  // amplification even though the row count stays bounded. The PK doubles as the
  // ON CONFLICT target.
  (table) => [
    // Explicit short name: the auto-generated one is 75 bytes and Postgres
    // silently truncates identifiers to 63, drifting the live constraint name
    // from the schema/snapshot.
    primaryKey({
      name: 'desktop_downloads_pk',
      columns: [
        table.version,
        table.platform,
        table.arch,
        table.format,
        table.installScope,
        table.country,
        table.day,
      ],
    }),
  ],
);
