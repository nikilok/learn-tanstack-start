CREATE TABLE "ch_stream_state" (
	"key" varchar(50) PRIMARY KEY NOT NULL,
	"last_timepoint" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies_house_profile_trails" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_number" varchar(20) NOT NULL,
	"column_name" varchar(100) NOT NULL,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ch_trail_company_number" ON "companies_house_profile_trails" USING btree ("company_number");--> statement-breakpoint
CREATE INDEX "idx_ch_trail_created_at" ON "companies_house_profile_trails" USING btree ("created_at");