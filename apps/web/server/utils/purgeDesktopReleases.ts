import { invalidateTags } from './invalidateTags';

/** Edge-cache tag on the public desktop-releases RPC (and SSR docs). */
export const DESKTOP_RELEASES_TAG = 'desktop-releases';

/**
 * Purges the desktop-releases edge tag. Returns false (no-op) when
 * VERCEL_CACHE_INVALIDATION is off — dev has no edge cache to purge — and
 * THROWS on API failure so callers decide whether that is fatal.
 */
export async function purgeDesktopReleases(): Promise<boolean> {
  if (process.env.VERCEL_CACHE_INVALIDATION !== 'true') return false;
  await invalidateTags([DESKTOP_RELEASES_TAG]);
  return true;
}
