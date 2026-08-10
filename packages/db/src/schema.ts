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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { ADDRESS_COLUMNS, slugifiedSqlText } from './constants';

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
    index('idx_hmrc_type_rating').on(table.typeRating),
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

// One CH previous-name with its date range; dates are 'YYYY-MM-DD' or null.
export type DatedPreviousName = {
  name: string;
  effectiveFrom: string | null;
  ceasedOn: string | null;
};

/** Map CH previous_company_names[] (snake_case dates) into stored DatedPreviousName[]. */
export function toDatedPreviousNames(
  prev:
    | {
        name?: string | null;
        effective_from?: string | null;
        ceased_on?: string | null;
      }[]
    | null
    | undefined,
): DatedPreviousName[] {
  return (prev ?? [])
    .filter((p) => !!p?.name) // guards null array elements, not just blank names
    .map((p) => ({
      name: p.name as string,
      effectiveFrom: p.effective_from ?? null,
      ceasedOn: p.ceased_on ?? null,
    }));
}

/** True when two dated previous-name arrays are equal (order + fields), key-order-insensitive. */
export function sameDatedPreviousNames(
  a: DatedPreviousName[],
  b: DatedPreviousName[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (x, i) =>
      x.name === b[i].name &&
      x.effectiveFrom === b[i].effectiveFrom &&
      x.ceasedOn === b[i].ceasedOn,
  );
}

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
    // Dated CH previous names (effective_from/ceased_on); text[] above drives search.
    previousCompanyNamesDated: jsonb('previous_company_names_dated')
      .$type<DatedPreviousName[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    index('idx_ch_date_of_creation').on(table.dateOfCreation),
    // Slugified-name probe for the company-page rename fallback.
    index('idx_ch_profiles_name_slugified').using(
      'btree',
      sql.raw(slugifiedSqlText('"company_name"')),
    ),
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
    // Slugified-name probe for the company-page rename fallback.
    index('idx_ch_prev_names_slugified').using(
      'btree',
      sql.raw(slugifiedSqlText('"name"')),
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
    // Slugified-name probe for the company-page rename fallback.
    index('idx_mapping_org_slugified').using(
      'btree',
      sql.raw(slugifiedSqlText('"organisation_name"')),
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
    // CH event time from the stream; null on rows written before 2026-07.
    publishedAt: timestamp('published_at'),
  },
  (table) => [
    index('idx_ch_trail_company_number').on(table.companyNumber),
    index('idx_ch_trail_created_at').on(table.createdAt),
    // /search hasMoved probe; predicate derives from the shared ADDRESS_COLUMNS.
    index('idx_ch_trail_address_change')
      .on(table.companyNumber)
      .where(
        sql`${table.columnName} IN (${sql.raw(
          ADDRESS_COLUMNS.map((c) => `'${c}'`).join(', '),
        )})`,
      ),
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

// Discovered company website, one row per company number. `evidence` is the
// upgrade-only ladder in apps/web/src/lib/websites/decide.ts, and
// `status='candidate'` IS the review backlog (no separate queue table).
// `checked_at` is the sweep cursor: selection LEFT JOINs this table and orders
// ASC NULLS FIRST, so a company with no row yet sorts first and
// discovery/refresh are the same pass.
//
// RENDER GATE: `status = 'verified' AND checked_at IS NOT NULL`, never status
// alone. status answers "whose site is this" — for a registry row that is an
// exact company-number join, and it is sound. It says nothing about whether the
// URL still resolves, and registry data rots badly: measured over 150 imported
// sponsor URLs on 2026-07-29, only 74% responded (CQC 71.5%, Wikidata 90%), the
// rest split between dead domains, timeouts and TLS name mismatches. The
// importer therefore leaves checked_at NULL, and only the sweep that has
// actually fetched a URL stamps it. Rendering on status alone puts a broken
// link on roughly one company page in four.
// Deliberately NOT foreign-keyed to companies_house_profiles, matching
// hmrc_company_mapping.company_number — a company can be mapped before its
// profile is fetched, and the generated FK name would exceed Postgres' 63-byte
// identifier limit (the trap migration 0034 had to undo).
export const companyWebsites = pgTable(
  'company_websites',
  {
    companyNumber: varchar('company_number', { length: 20 }).primaryKey(),
    // Canonical origin (scheme + host), null when status='none'.
    url: text('url'),
    // 'pending' | 'verified' | 'candidate' | 'unreachable' | 'none' | 'dead'.
    // `unreachable` exists because checked_at is the sweep CURSOR and is
    // stamped on every pass including failures: a row that failed to fetch but
    // stayed 'verified' would satisfy the render gate and publish a link we
    // could not reach. It returns to 'verified' on the next pass that answers.
    status: varchar('status', { length: 16 }).notNull(),
    evidence: varchar('evidence', { length: 24 }).notNull(),
    // Page the proof was found on — often /terms or /contact, not the homepage.
    evidenceUrl: text('evidence_url'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    source: varchar('source', { length: 24 }).notNull(),
    // Top search results retained for review, mirrors ch_search_results_top5.
    candidates: jsonb('candidates'),
    failureCount: smallint('failure_count').notNull().default(0),
    checkedAt: timestamp('checked_at'),
    verifiedAt: timestamp('verified_at'),
    discoveredAt: timestamp('discovered_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_company_websites_cursor').on(table.checkedAt.asc().nullsFirst()),
    index('idx_company_websites_status').on(table.status),
  ],
);

// Question set for the company-profiles corpus, one row per question. The
// table is the single source of truth for the extraction prompts: adding a
// question is an INSERT, retiring one sets active=false — never DELETE, dead
// slugs keep their answer rows interpretable.
export const profileQuestions = pgTable('profile_questions', {
  // 'what_does', 'offerings' — stable, readable identity for answer rows.
  slug: varchar('slug', { length: 64 }).primaryKey(),
  // The question as asked of the model.
  prompt: text('prompt').notNull(),
  // 'prose' | 'list' — drives the merge strategy.
  kind: varchar('kind', { length: 16 }).notNull(),
  // Why the question exists / how downstream should use it; aiming context.
  intent: text('intent').notNull(),
  active: boolean('active').notNull().default(true),
  // Assembly order in the per-page ask.
  sort: smallint('sort').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Cleaned page text captured by the company-profiles crawler, one row per
// (origin, path). Origin-keyed so companies sharing a domain crawl once, and
// persisted so prompt/model/question changes re-extract from here without
// touching any site again. Stores readable text only; raw HTML is never kept.
export const companyPageSnapshots = pgTable(
  'company_page_snapshots',
  {
    id: serial('id').primaryKey(),
    // Canonical origin (scheme + host), the dedupe key.
    origin: text('origin').notNull(),
    // '' for the homepage, '/about', ... — the frontier path as requested.
    path: text('path').notNull(),
    // Final post-redirect URL actually fetched.
    url: text('url').notNull(),
    // 'ok' | 'empty' | 'blocked' | 'error' | 'not_html'.
    status: varchar('status', { length: 16 }).notNull(),
    // Failure detail when the page was not read: web-fetch taxonomy value,
    // 'http_<code>', or 'challenge_page' (a WAF interstitial behind a 200).
    failure: varchar('failure', { length: 24 }),
    // 'fetch' | 'playwright' | 'manual' — which tier produced this attempt.
    // The escalation ladder's position marker; automated upserts never
    // overwrite a 'manual' row.
    fetchMethod: varchar('fetch_method', { length: 16 })
      .notNull()
      .default('fetch'),
    contentText: text('content_text'),
    contentHash: varchar('content_hash', { length: 64 }),
    bytes: integer('bytes'),
    fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  },
  // Doubles as the origin lookup index via the leftmost column.
  (table) => [
    uniqueIndex('ux_page_snapshots_origin_path').on(table.origin, table.path),
  ],
);

// Extracted answers, one row per (company, question). INTERNAL ONLY: nothing
// renders these and no RPC selects from this table. question_hash pins the
// prompt text that produced the row, so a prompt edit strands old-hash rows as
// stale and the nightly job re-extracts them from stored snapshots. Rows of a
// company that stops passing the render gate are archived to
// company_answers_archive, then deleted — never silently destroyed.
// Deliberately NOT foreign-keyed to companies_house_profiles, matching
// company_websites (and the 63-byte FK-name trap migration 0034 had to undo);
// the profile_questions FK is short and stays.
export const companyAnswers = pgTable(
  'company_answers',
  {
    id: serial('id').primaryKey(),
    companyNumber: varchar('company_number', { length: 20 }).notNull(),
    questionSlug: varchar('question_slug', { length: 64 })
      .notNull()
      .references(() => profileQuestions.slug),
    // Hash of the prompt text that produced this row — the staleness key.
    questionHash: varchar('question_hash', { length: 64 }).notNull(),
    // Verbatim prompt, so rows stay self-describing after edits/retirement.
    questionText: text('question_text').notNull(),
    // kind='prose' result.
    answer: text('answer'),
    // kind='list' result.
    items: jsonb('items').$type<string[]>(),
    // Snapshot URLs that contributed to the answer — provenance.
    sourceUrls: jsonb('source_urls')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Website evidence tier at extraction time (lib/websites/decide.ts ladder).
    identityEvidence: varchar('identity_evidence', { length: 24 }).notNull(),
    // Model identifier from the @ss/gemma model pin at extraction time.
    model: varchar('model', { length: 64 }).notNull(),
    // 'ok' | 'insufficient_content' | 'error'.
    status: varchar('status', { length: 24 }).notNull(),
    extractedAt: timestamp('extracted_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('ux_company_answers_company_question').on(
      table.companyNumber,
      table.questionSlug,
    ),
    // Staleness rotation: missing/oldest-extracted first within a question.
    index('idx_company_answers_staleness').on(
      table.questionSlug,
      table.extractedAt,
    ),
  ],
);

// Cold append-only history of company_answers, written at identity-severance
// moments (the mark-never-destroy pattern of companies_house_profile_trails).
// `id` carries the archived row's original id, so the archive insert is
// idempotent and a crash between archive and delete loses nothing. reason:
// 'website_demoted' today; 'reattributed'/'superseded' are future policy
// dials, not schema changes. source_urls preserve which domain the knowledge
// came from. Nothing reads this table yet.
export const companyAnswersArchive = pgTable(
  'company_answers_archive',
  {
    id: integer('id').primaryKey(),
    companyNumber: varchar('company_number', { length: 20 }).notNull(),
    questionSlug: varchar('question_slug', { length: 64 }).notNull(),
    questionHash: varchar('question_hash', { length: 64 }).notNull(),
    questionText: text('question_text').notNull(),
    answer: text('answer'),
    items: jsonb('items').$type<string[]>(),
    sourceUrls: jsonb('source_urls').$type<string[]>().notNull(),
    identityEvidence: varchar('identity_evidence', { length: 24 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    extractedAt: timestamp('extracted_at').notNull(),
    archivedAt: timestamp('archived_at').defaultNow().notNull(),
    reason: varchar('reason', { length: 24 }).notNull(),
  },
  (table) => [
    // The story query: a company's knowledge history in time order.
    index('idx_answers_archive_company').on(
      table.companyNumber,
      table.archivedAt,
    ),
  ],
);

/**
 * Work distribution for profile extraction: one row = one origin currently
 * claimed by one worker. Claiming is a single INSERT .. ON CONFLICT (origin)
 * DO UPDATE .. WHERE lease-expired .. RETURNING, so two workers can never
 * hold the same origin; completion deletes the row. A crashed worker's claim
 * simply expires and the origin becomes claimable again — the answers ledger
 * backstops correctness, since extraction writes are idempotent upserts.
 * Crawling is never claimed; this table governs extraction (Gemma) work only,
 * and the future volunteer API wraps the same claim/release factories.
 */
export const profileWorkClaims = pgTable('profile_work_claims', {
  origin: text('origin').primaryKey(),
  claimedBy: varchar('claimed_by', { length: 64 }).notNull(),
  claimedAt: timestamp('claimed_at').defaultNow().notNull(),
});
