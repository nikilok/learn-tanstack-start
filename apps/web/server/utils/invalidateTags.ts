import { Vercel } from '@vercel/sdk';

/** Vercel edge-cache API limit: at most 16 tags per invalidate request. */
export const TAG_BATCH_SIZE = 16;

/**
 * Purges the given Vercel edge-cache tags, batched to the API's per-request tag
 * limit. The caller decides whether to invoke it (e.g. gated on
 * VERCEL_CACHE_INVALIDATION); this just performs the purge via VERCEL_API_TOKEN /
 * VERCEL_PROJECT_ID.
 */
export async function invalidateTags(tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const vercel = new Vercel({ bearerToken: process.env.VERCEL_API_TOKEN });
  const projectIdOrName = process.env.VERCEL_PROJECT_ID as string;
  for (let i = 0; i < tags.length; i += TAG_BATCH_SIZE) {
    await vercel.edgeCache.invalidateByTags({
      projectIdOrName,
      requestBody: { tags: tags.slice(i, i + TAG_BATCH_SIZE) },
    });
  }
}
