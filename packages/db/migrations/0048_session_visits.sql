CREATE TABLE "session_visits" (
	"session_id" varchar(64) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"hour" timestamp NOT NULL,
	"first_seen" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_visits_session_id_slug_hour_pk" PRIMARY KEY("session_id","slug","hour")
);
--> statement-breakpoint
CREATE INDEX "idx_session_visits_hour" ON "session_visits" USING btree ("hour");
