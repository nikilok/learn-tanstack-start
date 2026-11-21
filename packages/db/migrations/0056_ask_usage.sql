CREATE TABLE "ask_usage" (
	"device_key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"asks" integer NOT NULL,
	"cooldown_until" timestamp with time zone
);
