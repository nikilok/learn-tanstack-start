/**
 * GET /downloads/:platform/:guid/:version/:file
 *
 * Public download URL for a desktop installer. Logs the hit to
 * desktop_downloads (fire-and-forget) and 302-redirects to the Vercel Blob
 * object that backs it, so the browser streams straight from the CDN under our
 * own domain. The `latest/` feed path (electron-updater channel files + updater
 * installers) redirects the same way but is NOT logged — those are update
 * checks/auto-updates, not user-initiated downloads.
 *
 * Not cached (no-store) so every hit reaches the function to log and so the
 * updater always resolves the freshest `latest/` object; the file bytes
 * themselves are CDN-cached by Blob.
 *
 * Env vars:
 *  - BLOB_PUBLIC_BASE — Blob store public host (https://<id>.public.blob.vercel-storage.com)
 *  - POSTGRES_URL     — shared Neon URL
 */
import {
  desktopDownloads,
  desktopReleaseAssets,
  desktopReleases,
} from '@ss/db/schema';
import { waitUntil } from '@vercel/functions';
import { eq } from 'drizzle-orm';
import { defineEventHandler } from 'h3';

import { DESKTOP_FORMATS, DESKTOP_PLATFORMS } from '#/api/desktopPlatforms';
import { db } from '#/db.server';

const PLATFORMS = new Set<string>(DESKTOP_PLATFORMS);
const INSTALLER_EXT = new RegExp(`\\.(${DESKTOP_FORMATS.join('|')})$`, 'i');

export default defineEventHandler((event) => {
  const base = process.env.BLOB_PUBLIC_BASE;
  if (!base) {
    console.error('[downloads] BLOB_PUBLIC_BASE not set');
    return new Response(null, { status: 500 });
  }

  const path = (event.context.params?.path as string | undefined) ?? '';
  if (!path || path.includes('..')) {
    return new Response(null, { status: 400 });
  }

  const segments = path.split('/');
  const [platform, guid, version, file] = segments;

  // Log genuine installer downloads by resolving the asset via its guid (the
  // authoritative key already in the URL): spoofed / latest-feed / unknown paths
  // never insert, and every recorded field — incl. version, from the joined
  // release — comes from the DB, not the (spoofable) URL. Off the redirect
  // critical path via waitUntil.
  if (
    platform &&
    guid &&
    version &&
    file &&
    segments.length === 4 &&
    PLATFORMS.has(platform) &&
    INSTALLER_EXT.test(file)
  ) {
    const country = event.req.headers.get('x-vercel-ip-country');
    waitUntil(
      (async () => {
        const [row] = await db
          .select({
            platform: desktopReleaseAssets.platform,
            arch: desktopReleaseAssets.arch,
            format: desktopReleaseAssets.format,
            installScope: desktopReleaseAssets.installScope,
            version: desktopReleases.version,
          })
          .from(desktopReleaseAssets)
          .innerJoin(
            desktopReleases,
            eq(desktopReleaseAssets.releaseId, desktopReleases.id),
          )
          .where(eq(desktopReleaseAssets.guid, guid))
          .limit(1);
        if (!row) return; // unknown guid — spoofed or stale path, don't log
        await db.insert(desktopDownloads).values({
          version: row.version,
          platform: row.platform,
          arch: row.arch,
          format: row.format,
          installScope: row.installScope,
          country,
        });
      })().catch((err) => {
        console.error('[downloads] log failed:', err);
      }),
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${base}/downloads/${path}`,
      'Cache-Control': 'no-store',
    },
  });
});
