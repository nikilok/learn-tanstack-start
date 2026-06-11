CREATE TABLE "ch_previous_names" (
	"company_number" varchar(20) NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "ch_previous_names_company_number_name_pk" PRIMARY KEY("company_number","name")
);
--> statement-breakpoint
ALTER TABLE "ch_previous_names" ADD CONSTRAINT "ch_previous_names_company_number_companies_house_profiles_company_number_fk" FOREIGN KEY ("company_number") REFERENCES "public"."companies_house_profiles"("company_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ch_prev_names_trgm" ON "ch_previous_names" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_mapping_company_number" ON "hmrc_company_mapping" USING btree ("company_number");--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_ch_previous_names() RETURNS trigger AS $$
BEGIN
	DELETE FROM ch_previous_names WHERE company_number = NEW.company_number;
	INSERT INTO ch_previous_names (company_number, name)
	SELECT DISTINCT NEW.company_number, n FROM unnest(NEW.previous_company_names) AS n
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER trg_sync_ch_previous_names
	AFTER INSERT OR UPDATE OF previous_company_names ON companies_house_profiles
	FOR EACH ROW EXECUTE FUNCTION sync_ch_previous_names();--> statement-breakpoint
INSERT INTO ch_previous_names (company_number, name)
	SELECT DISTINCT company_number, n FROM companies_house_profiles, unnest(previous_company_names) AS n
	ON CONFLICT DO NOTHING;