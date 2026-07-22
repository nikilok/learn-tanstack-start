CREATE INDEX "idx_ch_trail_address_change" ON "companies_house_profile_trails" USING btree ("company_number") WHERE "companies_house_profile_trails"."column_name" IN ('addressLine1', 'addressLine2', 'locality', 'region', 'postalCode', 'country');--> statement-breakpoint
CREATE INDEX "idx_ch_date_of_creation" ON "companies_house_profiles" USING btree ("date_of_creation");--> statement-breakpoint
CREATE INDEX "idx_ch_locality_lower" ON "companies_house_profiles" USING btree (lower("locality"));--> statement-breakpoint
CREATE INDEX "idx_hmrc_type_rating" ON "hmrc_skilled_workers" USING btree ("type_rating");--> statement-breakpoint
CREATE INDEX "idx_hmrc_town_city_lower" ON "hmrc_skilled_workers" USING btree (lower("town_city"));