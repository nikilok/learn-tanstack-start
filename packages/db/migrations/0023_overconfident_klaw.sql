CREATE TABLE "hmrc_company_mapping_review_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"organisation_name" text NOT NULL,
	"reason" varchar(40) NOT NULL,
	"existing_company_number" varchar(20),
	"existing_match_method" varchar(32),
	"existing_match_score" numeric(4, 3),
	"proposed_company_number" varchar(20),
	"proposed_match_method" varchar(32),
	"proposed_match_score" numeric(4, 3),
	"proposed_query_used" text,
	"ch_search_results_top5" jsonb,
	"detected_by" varchar(100) NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" varchar(100),
	"resolution" varchar(40)
);
--> statement-breakpoint
CREATE INDEX "idx_review_queue_unresolved" ON "hmrc_company_mapping_review_queue" USING btree ("detected_at") WHERE "hmrc_company_mapping_review_queue"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_review_queue_org" ON "hmrc_company_mapping_review_queue" USING btree ("organisation_name");--> statement-breakpoint
CREATE INDEX "idx_mapping_method_verified" ON "hmrc_company_mapping" USING btree ("match_method","verified_at" NULLS FIRST);