-- Enable trigram extension for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Add GIN trigram index on organisation_name for fast similarity lookups
CREATE INDEX IF NOT EXISTS idx_hmrc_org_name_trgm
  ON "hmrc_skilled_workers"
  USING gin ("organisation_name" gin_trgm_ops);
