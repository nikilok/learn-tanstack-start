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
ALTER TABLE "desktop_downloads" ADD COLUMN "count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_desktop_downloads_bucket" ON "desktop_downloads" USING btree ("version","platform","arch","format","install_scope","country","day");--> statement-breakpoint
ALTER TABLE "desktop_downloads" DROP COLUMN "downloaded_at";