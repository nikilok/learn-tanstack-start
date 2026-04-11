ALTER TABLE "companies_house_profiles" ADD COLUMN "accounts_overdue" boolean;--> statement-breakpoint
ALTER TABLE "companies_house_profiles" ADD COLUMN "jurisdiction" varchar(100);--> statement-breakpoint
ALTER TABLE "companies_house_profiles" ADD COLUMN "has_been_liquidated" boolean;--> statement-breakpoint
ALTER TABLE "companies_house_profiles" ADD COLUMN "has_insolvency_history" boolean;--> statement-breakpoint
ALTER TABLE "companies_house_profiles" ADD COLUMN "has_charges" boolean;--> statement-breakpoint
ALTER TABLE "companies_house_profiles" ADD COLUMN "previous_company_names" text[] DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "companies_house_profiles" ADD COLUMN "confirmation_statement_last_made_up_to" date;--> statement-breakpoint
CREATE INDEX "idx_ch_jurisdiction" ON "companies_house_profiles" USING btree ("jurisdiction");--> statement-breakpoint
CREATE INDEX "idx_ch_previous_names" ON "companies_house_profiles" USING gin ("previous_company_names");