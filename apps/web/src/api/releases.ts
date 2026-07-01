import { desktopReleaseAssets, desktopReleases } from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { asc, desc, inArray } from 'drizzle-orm';

import { db } from '../db.server';
import {
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setRpcCacheControl,
  setSsrCacheTag,
} from './cache-headers';

export type DesktopPlatform = 'mac' | 'win' | 'linux';

export type DesktopAsset = {
  platform: DesktopPlatform;
  arch: string;
  format: string;
  installScope: string;
  fileName: string;
  url: string;
  size: number | null;
};

export type DesktopRelease = {
  version: string;
  channel: string;
  notes: string | null;
  publishedAt: string;
  assets: Record<DesktopPlatform, DesktopAsset[]>;
};

/** Empty per-platform asset buckets. */
function emptyGroups(): Record<DesktopPlatform, DesktopAsset[]> {
  return { mac: [], win: [], linux: [] };
}

/** Loads releases + their assets grouped per platform (throws on DB error). */
async function loadReleases(): Promise<DesktopRelease[]> {
  const releases = await db
    .select()
    .from(desktopReleases)
    .orderBy(desc(desktopReleases.publishedAt))
    .limit(50);

  if (releases.length === 0) return [];

  const assets = await db
    .select()
    .from(desktopReleaseAssets)
    .where(
      inArray(
        desktopReleaseAssets.releaseId,
        releases.map((r) => r.id),
      ),
    )
    .orderBy(
      asc(desktopReleaseAssets.arch),
      asc(desktopReleaseAssets.format),
      asc(desktopReleaseAssets.installScope),
    );

  const byRelease = new Map<number, Record<DesktopPlatform, DesktopAsset[]>>();
  for (const r of releases) byRelease.set(r.id, emptyGroups());
  for (const a of assets) {
    const group = byRelease.get(a.releaseId);
    const platform = a.platform as DesktopPlatform;
    if (!group || !(platform in group)) continue;
    group[platform].push({
      platform,
      arch: a.arch,
      format: a.format,
      installScope: a.installScope,
      fileName: a.fileName,
      url: a.url,
      size: a.size,
    });
  }

  return releases.map(
    (r): DesktopRelease => ({
      version: r.version,
      channel: r.channel,
      notes: r.notes,
      publishedAt: r.publishedAt.toISOString(),
      assets: byRelease.get(r.id) ?? emptyGroups(),
    }),
  );
}

/**
 * Server fn returning every published desktop release (newest first) with its
 * download variants grouped by platform. Edge-cached and tagged
 * `desktop-releases`; the release write endpoint purges that tag on publish.
 * Returns `[]` when no releases exist yet or the query fails.
 */
export const getDesktopReleases = createServerFn().handler(async () => {
  setSsrCacheTag('desktop-releases');
  try {
    const releases = await loadReleases();
    // Long-cache a populated list (purged on publish); short-cache an empty one
    // so a pre-first-release visit or a no-op purge can't strand "no builds" for
    // 30 days with no time-based recovery.
    setRpcCacheControl(
      releases.length > 0 ? LONG_EDGE_CACHE : SHORT_EDGE_CACHE,
    );
    return releases;
  } catch (err) {
    console.error('[getDesktopReleases] failed', err);
    setRpcCacheControl(SHORT_EDGE_CACHE);
    return [] as DesktopRelease[];
  }
});

/**
 * React Query options for the desktop-release registry. Only changes on a new
 * release (which purges the edge tag), so never refetch within a session.
 */
export const desktopReleasesQueryOptions = queryOptions({
  queryKey: ['desktop-releases'],
  queryFn: () => getDesktopReleases(),
  staleTime: Number.POSITIVE_INFINITY,
});
