CREATE TABLE "website_stated_numbers" (
	"host" varchar(253) NOT NULL,
	"company_number" varchar(20) NOT NULL,
	"page_url" text NOT NULL,
	"context" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "website_stated_numbers_pk" PRIMARY KEY("host","company_number")
);
--> statement-breakpoint
ALTER TABLE "company_websites" ADD COLUMN "walk_version" smallint;--> statement-breakpoint
ALTER TABLE "company_websites" ADD COLUMN "walk_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_websites" ADD COLUMN "walked_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_website_stated_numbers_company" ON "website_stated_numbers" USING btree ("company_number");