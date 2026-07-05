import { desktopReleaseAssets, desktopReleases } from '@ss/db';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { asc, desc, eq, inArray } from 'drizzle-orm';

import {
  DESKTOP_RELEASES_TAG,
  purgeDesktopReleases,
} from '../../server/utils/purgeDesktopReleases';
import { db } from '../db.server';
import { isOwnerRequest } from '../owner.server';
import {
  LONG_EDGE_CACHE,
  SHORT_EDGE_CACHE,
  setRpcCacheControl,
  setSsrCacheControl,
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

/**
 * Loads releases + their assets grouped per platform (throws on DB error).
 * The visibility filter must be SQL-side: filtering after limit(50) would let
 * private rows evict older public releases from the public window.
 */
async function loadReleases(onlyPublic = false): Promise<DesktopRelease[]> {
  const visibility = onlyPublic
    ? eq(desktopReleases.visibility, 'public')
    : undefined;
  // The assets query scopes itself to the same release window via an
  // IN-subquery instead of waiting for the releases result, so both queries
  // run in parallel — one neon-http round-trip of latency instead of two.
  const releaseWindow = db
    .select({ id: desktopReleases.id })
    .from(desktopReleases)
    .where(visibility)
    .orderBy(desc(desktopReleases.publishedAt))
    .limit(50);
  const [releases, assets] = await Promise.all([
    db
      .select()
      .from(desktopReleases)
      .where(visibility)
      .orderBy(desc(desktopReleases.publishedAt))
      .limit(50),
    db
      .select()
      .from(desktopReleaseAssets)
      .where(inArray(desktopReleaseAssets.releaseId, releaseWindow))
      .orderBy(
        asc(desktopReleaseAssets.arch),
        asc(desktopReleaseAssets.format),
        asc(desktopReleaseAssets.installScope),
      ),
  ]);

  if (releases.length === 0) return [];

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
  setSsrCacheTag(DESKTOP_RELEASES_TAG);
  try {
    const releases = await loadReleases(true);
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
 * and `releases` is the FULL registry (public + private) as ONE consistent
 * snapshot — the page renders it INSTEAD of merging the cached public list
 * with a private-only list, which would transiently duplicate or drop a
 * release while the two queries refetch at different speeds after a
 * publish/unpublish flip. Anonymous viewers get `{ owner: false, releases: [] }`
 * without touching the DB. Never cached: the response is viewer-specific
 * ( /download documents are rendered per-request, so SSR-ing this is safe).
 * Auth fails closed (isOwnerRequest never throws), but a DB error for a proven
 * owner deliberately propagates — silently downgrading to the anonymous view
 * would misreport private releases as gone.
 */
export const getOwnerDesktopReleases = createServerFn().handler(async () => {
  setRpcCacheControl('private, no-store');
  if (!(await isOwnerRequest())) {
    return { owner: false, releases: [] as DesktopRelease[] };
  }
  // Belt-and-braces for the never-cache invariant: stamp the owner-variant
  // document too, so a future routeRule or heuristic proxy can't store it.
  setSsrCacheControl('private, no-store');
  return { owner: true, releases: await loadReleases() };
});

/**
 * Owner-only mutation flipping one release between private and public, then
 * purging the `desktop-releases` edge tag so the public list updates
 * immediately. A purge failure is reported (`purgeFailed`) rather than fatal:
 * the row IS flipped, but the edge-cached public RPC may lag for client-side
 * navs until the next successful purge (fresh document loads are unaffected).
 */
export const setReleaseVisibility = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { version: string; visibility: 'private' | 'public' }) => {
      // Real runtime checks — the type annotation alone validates nothing.
      if (
        typeof input?.version !== 'string' ||
        input.version.length === 0 ||
        input.version.length > 32 || // varchar(32) column
        (input.visibility !== 'private' && input.visibility !== 'public')
      ) {
        throw new Error('invalid payload');
      }
      return { version: input.version, visibility: input.visibility };
    },
  )
  .handler(async ({ data }) => {
    if (!(await isOwnerRequest())) return { ok: false as const };
    const updated = await db
      .update(desktopReleases)
      .set({ visibility: data.visibility })
      .where(eq(desktopReleases.version, data.version))
      .returning({ id: desktopReleases.id });
    if (updated.length === 0) return { ok: false as const };
    let purgeFailed = false;
    try {
      await purgeDesktopReleases();
    } catch (err) {
      purgeFailed = true;
      console.error('[setReleaseVisibility] purge failed', err);
    }
    return { ok: true as const, purgeFailed };
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
 * React Query options for the owner view. Short staleTime so each navigation
 * re-checks the cookies (cheap for anonymous viewers — no DB touch) WITHOUT
 * the staleTime-0 pathology of refetching immediately after hydrating the
 * SSR-fetched result on every single pageview.
 */
export const ownerDesktopReleasesQueryOptions = queryOptions({
  queryKey: ['desktop-releases-owner'],
  queryFn: () => getOwnerDesktopReleases(),
  staleTime: 30_000,
});
