DROP INDEX IF EXISTS "idx_hmrc_town_city";--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" DROP COLUMN IF EXISTS "town_city";--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" DROP COLUMN IF EXISTS "county";