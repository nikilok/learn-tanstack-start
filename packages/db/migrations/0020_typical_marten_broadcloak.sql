ALTER TABLE "hmrc_skilled_workers" ADD COLUMN "name_slug" varchar(255);--> statement-breakpoint
UPDATE "hmrc_skilled_workers" SET "name_slug" = regexp_replace(regexp_replace(lower("organisation_name"), '[^a-z0-9]+', '-', 'g'), '^-|-$', '', 'g');--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" ALTER COLUMN "name_slug" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_hmrc_name_slug" ON "hmrc_skilled_workers" USING btree ("name_slug");
