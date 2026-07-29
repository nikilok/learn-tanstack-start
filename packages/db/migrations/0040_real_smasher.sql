-- Company website discovery. The neon migrator is per-statement (no wrapping
-- transaction), so a crash between the CREATE TABLE and the indexes must leave
-- this file re-runnable — hence the IF NOT EXISTS guards on a generated file
-- (same treatment as 0039).
CREATE TABLE IF NOT EXISTS "company_websites" (
	"company_number" varchar(20) PRIMARY KEY NOT NULL,
	"url" text,
	"status" varchar(16) NOT NULL,
	"evidence" varchar(24) NOT NULL,
	"evidence_url" text,
	"confidence" numeric(4, 3),
	"source" varchar(24) NOT NULL,
	"candidates" jsonb,
	"failure_count" smallint DEFAULT 0 NOT NULL,
	"checked_at" timestamp,
	"verified_at" timestamp,
	"discovered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_company_websites_cursor" ON "company_websites" USING btree ("checked_at" NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_company_websites_status" ON "company_websites" USING btree ("status");
