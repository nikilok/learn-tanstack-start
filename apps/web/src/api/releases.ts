import { desktopReleaseAssets, desktopReleases } from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { asc, desc, eq, inArray } from 'drizzle-orm';

import { invalidateTags } from '../../server/utils/invalidateTags';
import { db } from '../db.server';
import { isOwnerRequest } from '../owner.server';
import {
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setRpcCacheControl,
  setSsrCacheTag,
} from './cache-headers';
import type { DesktopPlatform } from './desktopPlatforms';

export type { DesktopPlatform };

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
  /** 'private' releases render only for the owner (with a Private pill). */
  visibility: 'private' | 'public';
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
      visibility: r.visibility === 'public' ? 'public' : 'private',
      publishedAt: r.publishedAt.toISOString(),
      assets: byRelease.get(r.id) ?? emptyGroups(),
    }),
  );
}

/**
 * Server fn returning the PUBLIC desktop releases (newest first) with their
 * download variants grouped by platform. Edge-cached and tagged
 * `desktop-releases`; the release write endpoint and the owner publish action
 * both purge that tag, so this can stay long-cached. Returns `[]` when no
 * public releases exist yet or the query fails.
 */
export const getDesktopReleases = createServerFn().handler(async () => {
  setSsrCacheTag('desktop-releases');
  try {
    const releases = (await loadReleases()).filter(
      (r) => r.visibility === 'public',
    );
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
 * Server fn for the owner's view: `owner` says whether this request proved
 * team membership (durable cookie or toolbar bootstrap — see owner.server.ts),
 * and `releases` holds the private ones to fold into the page. Anonymous
 * viewers get `{ owner: false, releases: [] }` without touching the DB. Never
 * cached: the response is viewer-specific ( /download documents are rendered
 * per-request, so SSR-ing this is safe).
 */
export const getPrivateDesktopReleases = createServerFn().handler(async () => {
  setRpcCacheControl('private, no-store');
  try {
    if (!(await isOwnerRequest())) {
      return { owner: false, releases: [] as DesktopRelease[] };
    }
    const releases = (await loadReleases()).filter(
      (r) => r.visibility === 'private',
    );
    return { owner: true, releases };
  } catch (err) {
    console.error('[getPrivateDesktopReleases] failed', err);
    return { owner: false, releases: [] as DesktopRelease[] };
  }
});

/**
 * Owner-only mutation flipping one release between private and public, then
 * purging the `desktop-releases` edge tag so the public list updates
 * immediately (purge is env-gated like the release endpoint's; a failure is
 * logged, not fatal — the long cache would then lag until the next purge).
 */
export const setReleaseVisibility = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { version: string; visibility: 'private' | 'public' }) => input,
  )
  .handler(async ({ data }) => {
    if (!(await isOwnerRequest())) return { ok: false as const };
    const visibility = data.visibility === 'public' ? 'public' : 'private';
    const updated = await db
      .update(desktopReleases)
      .set({ visibility })
      .where(eq(desktopReleases.version, data.version))
      .returning({ id: desktopReleases.id });
    if (updated.length === 0) return { ok: false as const };
    if (process.env.VERCEL_CACHE_INVALIDATION === 'true') {
      await invalidateTags(['desktop-releases']).catch((err) =>
        console.error('[setReleaseVisibility] purge failed', err),
      );
    }
    return { ok: true as const };
  });

/**
 * React Query options for the public desktop-release registry. Only changes on
 * a publish (which purges the edge tag), so never refetch within a session.
 */
export const desktopReleasesQueryOptions = queryOptions({
  queryKey: ['desktop-releases'],
  queryFn: () => getDesktopReleases(),
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * React Query options for the owner view. staleTime 0 so every /download visit
 * re-checks the cookies — cheap for anonymous viewers (no DB touch).
 */
export const privateDesktopReleasesQueryOptions = queryOptions({
  queryKey: ['desktop-releases-private'],
  queryFn: () => getPrivateDesktopReleases(),
  staleTime: 0,
});
