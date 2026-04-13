CREATE TABLE "hmrc_ingestion_meta" (
	"id" serial PRIMARY KEY NOT NULL,
	"csv_url" text NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"record_count" integer NOT NULL,
	"ingested_at" timestamp DEFAULT now() NOT NULL
);
