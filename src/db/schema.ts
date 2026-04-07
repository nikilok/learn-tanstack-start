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

export const hmrcIngestionMeta = pgTable('hmrc_ingestion_meta', {
  id: serial('id').primaryKey(),
  csvUrl: text('csv_url').notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  recordCount: integer('record_count').notNull(),
  ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
});
