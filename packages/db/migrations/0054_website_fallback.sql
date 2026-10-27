ALTER TABLE "company_websites" ADD COLUMN "fallback_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "company_websites" ADD COLUMN "fallback_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_websites" ADD COLUMN "link_url" text;