CREATE TABLE "profile_work_claims" (
	"origin" text PRIMARY KEY NOT NULL,
	"claimed_by" varchar(64) NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL
);
