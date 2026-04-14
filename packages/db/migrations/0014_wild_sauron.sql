CREATE TABLE "companies_house_profiles" (
	"company_number" varchar(20) PRIMARY KEY NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"company_status" varchar(50),
	"company_type" varchar(100),
	"date_of_creation" date,
	"address_line_1" varchar(255),
	"address_line_2" varchar(255),
	"locality" varchar(100),
	"region" varchar(100),
	"postal_code" varchar(20),
	"country" varchar(100),
	"sic_codes" text[] DEFAULT '{}'::text[],
	"accounts_next_made_up_to" date,
	"accounts_last_made_up_to" date,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ch_company_name" ON "companies_house_profiles" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "idx_ch_company_status" ON "companies_house_profiles" USING btree ("company_status");--> statement-breakpoint
CREATE INDEX "idx_ch_company_type" ON "companies_house_profiles" USING btree ("company_type");--> statement-breakpoint
CREATE INDEX "idx_ch_sic_codes" ON "companies_house_profiles" USING gin ("sic_codes");