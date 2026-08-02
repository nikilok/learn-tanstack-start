import { Vercel } from '@vercel/sdk';

/** Vercel edge-cache API limit: at most 16 tags per invalidate request. */
export const TAG_BATCH_SIZE = 16;

/**
 * Purges the given Vercel edge-cache tags, batched to the API's per-request
 * tag limit and gated on VERCEL_CACHE_INVALIDATION — the ONE copy of the
 * live-purge gate. Returns false as a dry no-op when invalidation is off (dev
 * and preview have no edge cache to purge). THROWS on missing credentials or
 * API failure — a failed purge must be the caller's decision: revalidate
 * relies on the throw to NOT advance its trail cursor (so the purge retries
 * next call) and to turn its ?purge mode into a 500, while the release
 * endpoint wraps it in waitUntil().catch as best-effort.
 */
export async function invalidateTagsIfLive(tags: string[]): Promise<boolean> {
  if (process.env.VERCEL_CACHE_INVALIDATION !== 'true') return false;
  if (tags.length === 0) return true;
  const token = process.env.VERCEL_API_TOKEN;
  const projectIdOrName = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectIdOrName) {
    throw new Error(
      '[invalidateTags] VERCEL_API_TOKEN / VERCEL_PROJECT_ID missing — cannot purge',
    );
  }
  const vercel = new Vercel({ bearerToken: token });
  for (let i = 0; i < tags.length; i += TAG_BATCH_SIZE) {
    await vercel.edgeCache.invalidateByTags({
      projectIdOrName,
      requestBody: { tags: tags.slice(i, i + TAG_BATCH_SIZE) },
    });
  }
  return true;
}
