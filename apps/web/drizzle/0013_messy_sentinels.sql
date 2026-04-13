ALTER TABLE "hmrc_skilled_workers" ADD COLUMN "hash" varchar(11) NOT NULL;--> statement-breakpoint
ALTER TABLE "hmrc_skilled_workers" ADD CONSTRAINT "hmrc_skilled_workers_hash_unique" UNIQUE("hash");