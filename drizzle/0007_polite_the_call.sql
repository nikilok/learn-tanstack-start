CREATE TABLE "hmrc_skilled_workers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organisation_name" varchar(255) NOT NULL,
	"town_city" varchar(100),
	"county" varchar(100),
	"type_rating" varchar(100) NOT NULL,
	"route" varchar(100) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_hmrc_org_name" ON "hmrc_skilled_workers" USING btree ("organisation_name");--> statement-breakpoint
CREATE INDEX "idx_hmrc_town_city" ON "hmrc_skilled_workers" USING btree ("town_city");--> statement-breakpoint
CREATE INDEX "idx_hmrc_route" ON "hmrc_skilled_workers" USING btree ("route");