CREATE TABLE "companies_house_profile_cache" (
	"key" varchar(50) PRIMARY KEY NOT NULL,
	"last_trail_id" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
