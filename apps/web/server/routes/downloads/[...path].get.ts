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
import { createClient } from '@ss/db/client';
import { desktopDownloads } from '@ss/db/schema';
import { waitUntil } from '@vercel/functions';
import { defineEventHandler } from 'h3';

const db = createClient(process.env.POSTGRES_URL as string);

const PLATFORMS = new Set(['mac', 'win', 'linux']);
const INSTALLER_EXT = /\.(dmg|exe|deb|rpm|AppImage)$/i;

/** Best-effort {arch, format, installScope} from an installer filename, for analytics only. */
function parseFilename(file: string): {
  arch: string | null;
  format: string | null;
  installScope: string | null;
} {
  const lower = file.toLowerCase();
  const format = lower.match(/\.(dmg|exe|deb|rpm|appimage)$/)?.[1] ?? null;
  const arch = /arm64|aarch64/.test(lower)
    ? 'arm64'
    : /universal/.test(lower)
      ? 'universal'
      : /x64|x86_64|amd64/.test(lower)
        ? 'x64'
        : null;
  const installScope = /system/.test(lower)
    ? 'system'
    : /user/.test(lower)
      ? 'user'
      : null;
  return { arch, format, installScope };
}

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
  const [platform, , version, file] = segments;

  // Log genuine installer downloads (the 4-segment versioned path), never the
  // `latest/` updater feed (platform would be 'latest', not a real OS).
  if (
    platform &&
    PLATFORMS.has(platform) &&
    segments.length === 4 &&
    version &&
    file &&
    INSTALLER_EXT.test(file)
  ) {
    const { arch, format, installScope } = parseFilename(file);
    waitUntil(
      db
        .insert(desktopDownloads)
        .values({
          version,
          platform,
          arch,
          format,
          installScope,
          country: event.req.headers.get('x-vercel-ip-country'),
        })
        .catch((err) => {
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
