import {
  boolean,
  date,
  index,
  pgTable,
  serial,
  text,
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
  ],
);
