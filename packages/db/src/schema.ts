import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
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
    index('idx_hmrc_town_city').on(table.townCity),
    index('idx_hmrc_route').on(table.route),
    index('idx_hmrc_org_name_trgm').using(
      'gin',
      sql`${table.organisationName} gin_trgm_ops`,
    ),
  ],
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
    sicCodes: text('sic_codes').array().default(sql`'{}'::text[]`),
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
