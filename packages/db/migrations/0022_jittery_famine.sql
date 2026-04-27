CREATE TABLE "hmrc_company_mapping_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"organisation_name" text NOT NULL,
	"old_company_number" varchar(20),
	"new_company_number" varchar(20),
	"old_match_method" varchar(32),
	"new_match_method" varchar(32),
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"changed_by" varchar(100)
);
--> statement-breakpoint
ALTER TABLE "hmrc_company_mapping" ALTER COLUMN "company_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hmrc_company_mapping" ADD COLUMN "is_public_body" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hmrc_company_mapping" ADD COLUMN "match_method" varchar(32);--> statement-breakpoint
ALTER TABLE "hmrc_company_mapping" ADD COLUMN "match_score" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "hmrc_company_mapping" ADD COLUMN "query_used" text;--> statement-breakpoint
ALTER TABLE "hmrc_company_mapping" ADD COLUMN "verified_at" timestamp;