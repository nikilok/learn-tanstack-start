CREATE TABLE "desktop_downloads" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" varchar(32) NOT NULL,
	"platform" varchar(16) NOT NULL,
	"arch" varchar(16),
	"format" varchar(16),
	"install_scope" varchar(16),
	"country" varchar(2),
	"downloaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_release_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"release_id" integer NOT NULL,
	"platform" varchar(16) NOT NULL,
	"arch" varchar(16) NOT NULL,
	"format" varchar(16) NOT NULL,
	"install_scope" varchar(16) DEFAULT '' NOT NULL,
	"guid" varchar(32) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"size" integer,
	"sha512" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" varchar(32) NOT NULL,
	"channel" varchar(16) DEFAULT 'stable' NOT NULL,
	"notes" text,
	"published_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_releases_version_unique" UNIQUE("version")
);
--> statement-breakpoint
ALTER TABLE "desktop_release_assets" ADD CONSTRAINT "desktop_release_assets_release_id_desktop_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."desktop_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_desktop_downloads_ver_plat" ON "desktop_downloads" USING btree ("version","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_desktop_asset_variant" ON "desktop_release_assets" USING btree ("release_id","platform","arch","format","install_scope");--> statement-breakpoint
CREATE INDEX "idx_desktop_asset_guid" ON "desktop_release_assets" USING btree ("guid");