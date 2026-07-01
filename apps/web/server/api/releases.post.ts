/**
 * POST /api/releases
 *
 * Records a published desktop release + its per-variant download assets. Called
 * by the desktop release workflow after uploading installers to Vercel Blob.
 * Idempotent: upserts the release by version and each asset by its variant key,
 * so a re-run or a per-platform matrix job converges to the same rows.
 *
 * Auth:     x-desktop-release-secret header (timing-safe) vs DESKTOP_RELEASE_SECRET
 * Response: 200 { ok, releaseId } on success; 400 / 500 on error; a bad secret
 *           gets the neutral 202 from withSecret (no auth signal)
 *
 * Env vars:
 *  - DESKTOP_RELEASE_SECRET     — shared secret with the release workflow
 *  - POSTGRES_URL               — shared Neon URL
 *  - VERCEL_CACHE_INVALIDATION  — 'true' to purge the /download page cache tag
 *  - VERCEL_API_TOKEN / VERCEL_PROJECT_ID — Vercel SDK auth for the purge
 */
import { createClient } from '@ss/db/client';
import { desktopReleaseAssets, desktopReleases } from '@ss/db/schema';
import { waitUntil } from '@vercel/functions';
import { Vercel } from '@vercel/sdk';
import { sql } from 'drizzle-orm';
import { readBody } from 'h3';

import { json, withSecret } from '../utils/withSecret';

const db = createClient(process.env.POSTGRES_URL as string);

const PLATFORMS = new Set(['mac', 'win', 'linux']);

type AssetInput = {
  platform: string;
  arch: string;
  format: string;
  installScope?: string;
  guid: string;
  fileName: string;
  url: string;
  size?: number;
  sha512?: string;
};

/** Narrows one asset entry from the request body. */
function validAsset(a: unknown): a is AssetInput {
  if (!a || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  return (
    typeof o.platform === 'string' &&
    PLATFORMS.has(o.platform) &&
    typeof o.arch === 'string' &&
    typeof o.format === 'string' &&
    typeof o.guid === 'string' &&
    typeof o.fileName === 'string' &&
    typeof o.url === 'string'
  );
}

/** Purges the /download page's edge cache tag once a release is recorded. */
async function purgeDownloadCache(): Promise<void> {
  if (process.env.VERCEL_CACHE_INVALIDATION !== 'true') return;
  const vercel = new Vercel({ bearerToken: process.env.VERCEL_API_TOKEN });
  await vercel.edgeCache.invalidateByTags({
    projectIdOrName: process.env.VERCEL_PROJECT_ID as string,
    requestBody: { tags: ['desktop-releases'] },
  });
}

export default withSecret(
  'x-desktop-release-secret',
  process.env.DESKTOP_RELEASE_SECRET,
  async (event) => {
    const body = (await readBody(event).catch(() => null)) as {
      version?: unknown;
      channel?: unknown;
      notes?: unknown;
      assets?: unknown;
    } | null;

    const version = body?.version;
    const assets = body?.assets;
    if (
      typeof version !== 'string' ||
      version.length === 0 ||
      !Array.isArray(assets) ||
      assets.length === 0 ||
      !assets.every(validAsset)
    ) {
      return json({ error: 'invalid payload' }, 400);
    }

    try {
      const channel =
        typeof body?.channel === 'string' ? body.channel : 'stable';
      const notes = typeof body?.notes === 'string' ? body.notes : null;

      const [release] = await db
        .insert(desktopReleases)
        .values({ version, channel, notes })
        .onConflictDoUpdate({
          target: desktopReleases.version,
          set: { channel, notes },
        })
        .returning({ id: desktopReleases.id });

      const releaseId = release.id;
      const rows = (assets as AssetInput[]).map((a) => ({
        releaseId,
        platform: a.platform,
        arch: a.arch,
        format: a.format,
        installScope: a.installScope ?? '',
        guid: a.guid,
        fileName: a.fileName,
        url: a.url,
        size: a.size ?? null,
        sha512: a.sha512 ?? null,
      }));
      // Collapse duplicate variant keys (last wins) — a single INSERT..ON CONFLICT
      // errors "cannot affect row a second time" if two rows share the
      // (releaseId, platform, arch, format, installScope) conflict target.
      const deduped = [
        ...new Map(
          rows.map((r) => [
            `${r.platform}/${r.arch}/${r.format}/${r.installScope}`,
            r,
          ]),
        ).values(),
      ];

      await db
        .insert(desktopReleaseAssets)
        .values(deduped)
        .onConflictDoUpdate({
          target: [
            desktopReleaseAssets.releaseId,
            desktopReleaseAssets.platform,
            desktopReleaseAssets.arch,
            desktopReleaseAssets.format,
            desktopReleaseAssets.installScope,
          ],
          set: {
            guid: sql`excluded.guid`,
            fileName: sql`excluded.file_name`,
            url: sql`excluded.url`,
            size: sql`excluded.size`,
            sha512: sql`excluded.sha512`,
          },
        });

      // Best-effort: a cache-purge failure must not 500 the already-committed
      // write (that would fail the CI release job). Run it after the response.
      waitUntil(
        purgeDownloadCache().catch((err) =>
          console.error('[releases] cache purge failed:', err),
        ),
      );

      return json({ ok: true, releaseId }, 200);
    } catch (err) {
      console.error('[releases] write failed:', err);
      return json({ error: 'internal error' }, 500);
    }
  },
);
