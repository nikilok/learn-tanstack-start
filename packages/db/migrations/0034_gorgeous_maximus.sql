-- Rename the composite PK to a short explicit name. drizzle-kit auto-named it
-- 75 bytes in 0033, which Postgres truncated to 63 ("…install_scope_co") —
-- drifting the live name from the schema/snapshot. RENAME (metadata-only, no
-- PK-less window) FROM the actual truncated name, which is identical on prod and
-- any fresh DB after 0033, so this migration is portable. drizzle-kit generated
-- a DROP(75-char)+ADD, but the 75-char name never existed on any DB.
ALTER TABLE "desktop_downloads" RENAME CONSTRAINT "desktop_downloads_version_platform_arch_format_install_scope_co" TO "desktop_downloads_pk";
