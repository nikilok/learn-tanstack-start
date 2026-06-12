-- 2026-06-11 HMRC CSV revert: snapshot org→licence mapping before the next
-- ingest swap destroys it, restore town_city/county, drop licence/status.
-- Statements are idempotent: the neon migrator is per-statement (no wrapping
-- transaction), so a mid-file crash must be re-runnable.
CREATE TABLE IF NOT EXISTS "hmrc_sponsor_licences" (
	"id" serial PRIMARY KEY NOT NULL,
	"organisation_name" varchar(255) NOT NULL,
	"sponsor_licence_number" varchar(64) NOT NULL,
	"type_rating" varchar(100) NOT NULL,
	"route" varchar(100) NOT NULL,
	"sponsor_status" varchar(64),
	"snapshotted_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Backfill must precede the column drops below. Two re-run guards: NOT EXISTS
-- no-ops once rows are snapshotted (the INSERT's own rows are invisible at
-- statement-start snapshot), and the DO block skips when the source column is
-- already gone — a re-run after the drops below committed would otherwise
-- 42703 at parse time and wedge the migration chain, which NOT EXISTS cannot
-- prevent (parsing precedes execution; plpgsql plans the INSERT only when its
-- branch runs). Column-gone also covers an ingest-swap-before-migrate breach:
-- nothing left to snapshot, so proceed rather than wedge.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'hmrc_skilled_workers'
			AND column_name = 'sponsor_licence_number'
	) THEN
		INSERT INTO "hmrc_sponsor_licences"
			("organisation_name", "sponsor_licence_number", "type_rating", "route", "sponsor_status")
		SELECT DISTINCT "organisation_name", "sponsor_licence_number", "type_rating", "route", "sponsor_status"
		FROM "hmrc_skilled_workers"
		WHERE "sponsor_licence_number" IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM "hmrc_sponsor_licences");
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sponsor_licences_org" ON "hmrc_sponsor_licences" USING btree ("organisation_name");--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" ADD COLUMN IF NOT EXISTS "town_city" varchar(100);--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" ADD COLUMN IF NOT EXISTS "county" varchar(100);--> statement-breakpoint
DROP INDEX IF EXISTS "idx_hmrc_licence";--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" DROP COLUMN IF EXISTS "sponsor_licence_number";--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" DROP COLUMN IF EXISTS "sponsor_status";
