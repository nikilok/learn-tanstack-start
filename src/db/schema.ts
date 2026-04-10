import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  published: boolean('published').default(false),
  publishedAt: date('published_at'),
});

export const hmrcSkilledWorkers = pgTable(
  'hmrc_skilled_workers',
  {
    id: serial('id').primaryKey(),
    hash: varchar('hash', { length: 11 }).notNull().unique(),
    organisationName: varchar('organisation_name', { length: 255 }).notNull(),
    townCity: varchar('town_city', { length: 100 }),
    county: varchar('county', { length: 100 }),
    typeRating: varchar('type_rating', { length: 100 }).notNull(),
    route: varchar('route', { length: 100 }).notNull(),
  },
  (table) => [
    index('idx_hmrc_org_name').on(table.organisationName),
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
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_ch_company_name').on(table.companyName),
    index('idx_ch_company_status').on(table.companyStatus),
    index('idx_ch_company_type').on(table.companyType),
    index('idx_ch_sic_codes').using('gin', table.sicCodes),
  ],
);

export const hmrcIngestionMeta = pgTable('hmrc_ingestion_meta', {
  id: serial('id').primaryKey(),
  csvUrl: text('csv_url').notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  recordCount: integer('record_count').notNull(),
  ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
});
