-- Snapshot-bearing twin of hand-written 0038 (already applied to prod): the
-- schema.ts declarations needed a drizzle-kit generate so db:push/db:generate
-- see these indexes. IF NOT EXISTS makes it a no-op wherever 0038 ran.
CREATE INDEX IF NOT EXISTS "idx_ch_prev_names_slugified" ON "ch_previous_names" USING btree (btrim(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), '-'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ch_profiles_name_slugified" ON "companies_house_profiles" USING btree (btrim(regexp_replace(lower("company_name"), '[^a-z0-9]+', '-', 'g'), '-'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mapping_org_slugified" ON "hmrc_company_mapping" USING btree (btrim(regexp_replace(lower("organisation_name"), '[^a-z0-9]+', '-', 'g'), '-'));
