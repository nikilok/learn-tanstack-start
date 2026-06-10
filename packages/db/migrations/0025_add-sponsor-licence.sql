ALTER TABLE "hmrc_skilled_workers" ADD COLUMN IF NOT EXISTS "sponsor_licence_number" varchar(20);--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" ADD COLUMN IF NOT EXISTS "sponsor_status" varchar(64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmrc_licence" ON "hmrc_skilled_workers" USING btree ("sponsor_licence_number");