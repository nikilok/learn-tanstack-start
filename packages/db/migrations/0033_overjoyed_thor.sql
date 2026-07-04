-- Reshape desktop_downloads from append-per-hit into an aggregated per-day
-- bucket counter. Old per-hit rows don't map to buckets, so discard them
-- (analytics-only) — TRUNCATE first also lets the NOT NULL / ADD NOT NULL ops
-- apply on an empty table without a backfill. Statement order matters: the
-- composite PK is added LAST, after `id` (and its old PK) is dropped and after
-- `day` exists (drizzle-kit emitted them in a non-applicable order).
TRUNCATE TABLE "desktop_downloads";--> statement-breakpoint
DROP INDEX "idx_desktop_downloads_ver_plat";--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "arch" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "arch" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "format" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "format" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "install_scope" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "install_scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "country" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "desktop_downloads" ALTER COLUMN "country" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_downloads" ADD COLUMN "day" date NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_downloads" ADD COLUMN "count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_downloads" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "desktop_downloads" DROP COLUMN "downloaded_at";--> statement-breakpoint
ALTER TABLE "desktop_downloads" ADD CONSTRAINT "desktop_downloads_version_platform_arch_format_install_scope_country_day_pk" PRIMARY KEY("version","platform","arch","format","install_scope","country","day");
