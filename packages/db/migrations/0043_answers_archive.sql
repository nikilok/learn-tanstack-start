CREATE TABLE "company_answers_archive" (
	"id" integer PRIMARY KEY NOT NULL,
	"company_number" varchar(20) NOT NULL,
	"question_slug" varchar(64) NOT NULL,
	"question_hash" varchar(64) NOT NULL,
	"question_text" text NOT NULL,
	"answer" text,
	"items" jsonb,
	"source_urls" jsonb NOT NULL,
	"identity_evidence" varchar(24) NOT NULL,
	"model" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"extracted_at" timestamp NOT NULL,
	"archived_at" timestamp DEFAULT now() NOT NULL,
	"reason" varchar(24) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_answers_archive_company" ON "company_answers_archive" USING btree ("company_number","archived_at");