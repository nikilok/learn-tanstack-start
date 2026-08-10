CREATE TABLE "company_answers" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_number" varchar(20) NOT NULL,
	"question_slug" varchar(64) NOT NULL,
	"question_hash" varchar(64) NOT NULL,
	"question_text" text NOT NULL,
	"answer" text,
	"items" jsonb,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity_evidence" varchar(24) NOT NULL,
	"model" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_page_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"path" text NOT NULL,
	"url" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"failure" varchar(24),
	"content_text" text,
	"content_hash" varchar(64),
	"bytes" integer,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_questions" (
	"slug" varchar(64) PRIMARY KEY NOT NULL,
	"prompt" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"intent" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" smallint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_answers" ADD CONSTRAINT "company_answers_question_slug_profile_questions_slug_fk" FOREIGN KEY ("question_slug") REFERENCES "public"."profile_questions"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_company_answers_company_question" ON "company_answers" USING btree ("company_number","question_slug");--> statement-breakpoint
CREATE INDEX "idx_company_answers_staleness" ON "company_answers" USING btree ("question_slug","extracted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_page_snapshots_origin_path" ON "company_page_snapshots" USING btree ("origin","path");--> statement-breakpoint
INSERT INTO "profile_questions" ("slug", "prompt", "kind", "intent", "sort") VALUES
	('what_does', 'What does this company do?', 'prose', 'The one-paragraph identity of the business; used to match user descriptions of the kind of company they want.', 1),
	('offerings', 'What products or services does this company provide?', 'list', 'The concrete things the company sells or does for clients; used to match user descriptions of the work they want to do or buy.', 2);