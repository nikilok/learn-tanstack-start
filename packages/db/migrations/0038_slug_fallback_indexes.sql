-- Expression indexes for getHmrcCompanyBySlug's rename/alias fallback: the
-- expressions must stay textually identical to slugifySql in apps/web
-- src/api/hmrc.ts or the planner reverts to seq scans (~620ms per miss).
CREATE INDEX "idx_mapping_org_slugified" ON "hmrc_company_mapping" USING btree ((btrim(regexp_replace(lower("organisation_name"), '[^a-z0-9]+', '-', 'g'), '-')));--> statement-breakpoint
CREATE INDEX "idx_ch_prev_names_slugified" ON "ch_previous_names" USING btree ((btrim(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), '-')));--> statement-breakpoint
CREATE INDEX "idx_ch_profiles_name_slugified" ON "companies_house_profiles" USING btree ((btrim(regexp_replace(lower("company_name"), '[^a-z0-9]+', '-', 'g'), '-')));--> statement-breakpoint
-- Collect expression stats immediately: without them the planner over-estimates
-- the slugified lookups (~650 rows) and hash-joins a full mapping seq scan.
ANALYZE "hmrc_company_mapping";--> statement-breakpoint
ANALYZE "ch_previous_names";--> statement-breakpoint
ANALYZE "companies_house_profiles";
