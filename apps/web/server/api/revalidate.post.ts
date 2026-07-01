/**
 * POST /api/revalidate
 *
 * Invalidates Vercel CDN cache for company pages whose data has changed.
 * Called by ch-stream (Railway) after processing Companies House stream events.
 *
 * Auth:    x-revalidate-secret header (timing-safe comparison)
 * Response: always 202 Accepted (no auth signal to attackers)
 *
 * Behaviour:
 *  - Reads a cursor from companies_house_profile_cache to find new trail entries
 *  - Builds cache tags (company-{number}) for each changed company
 *  - VERCEL_CACHE_INVALIDATION=true:  calls Vercel SDK invalidateByTags, advances cursor
 *  - VERCEL_CACHE_INVALIDATION=false: logs tags (dry-run), cursor unchanged
 *  - On purge failure: cursor is NOT advanced, so next call retries
 *
 * Env vars (Vercel):
 *  - REVALIDATE_SECRET          — shared secret with ch-stream
 *  - VERCEL_CACHE_INVALIDATION  — 'true' to enable live purging
 *  - VERCEL_API_TOKEN           — Vercel API token for SDK auth
 *  - VERCEL_PROJECT_ID          — Vercel project to purge cache for
 */
import { createClient } from '@ss/db/client';
import {
  companiesHouseProfileCache,
  companiesHouseProfileTrails,
} from '@ss/db/schema';
import { waitUntil } from '@vercel/functions';
import { eq, gt, max } from 'drizzle-orm';

import { invalidateTags, TAG_BATCH_SIZE } from '../utils/invalidateTags.ts';
import { json, withSecret } from '../utils/withSecret.ts';

const db = createClient(process.env.POSTGRES_URL as string);

async function processRevalidation() {
  const [cursor] = await db
    .select()
    .from(companiesHouseProfileCache)
    .where(eq(companiesHouseProfileCache.key, 'vercel-cdn'))
    .limit(1);

  const lastTrailId = cursor?.lastTrailId ?? 0;

  // Vercel API allows 5 invalidate requests/min; cap at 5 batches
  // (TAG_BATCH_SIZE tags each) per invocation so the rest rolls to the next call.
  const MAX_COMPANIES = TAG_BATCH_SIZE * 5;

  const trails = await db
    .select({
      companyNumber: companiesHouseProfileTrails.companyNumber,
      maxId: max(companiesHouseProfileTrails.id),
    })
    .from(companiesHouseProfileTrails)
    .where(gt(companiesHouseProfileTrails.id, lastTrailId))
    .groupBy(companiesHouseProfileTrails.companyNumber)
    .limit(MAX_COMPANIES);

  if (trails.length === 0) {
    console.log('[revalidate] No new trails to process');
    return;
  }

  const newLastId = Math.max(...trails.map((t) => t.maxId ?? 0));
  const tags = trails.map((t) => `company-${t.companyNumber}`);

  const isLive = process.env.VERCEL_CACHE_INVALIDATION === 'true';

  if (!isLive) {
    console.log(
      `[revalidate:dry-run] Would invalidate ${tags.length} tags: ${tags.join(', ')}`,
    );
    return;
  }

  await invalidateTags(tags);

  await db
    .insert(companiesHouseProfileCache)
    .values({
      key: 'vercel-cdn',
      lastTrailId: newLastId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: companiesHouseProfileCache.key,
      set: { lastTrailId: newLastId, updatedAt: new Date() },
    });

  console.log(
    `[revalidate] Invalidated ${tags.length} tags, cursor advanced to ${newLastId}`,
  );
}

export default withSecret(
  'x-revalidate-secret',
  process.env.REVALIDATE_SECRET,
  () => {
    waitUntil(
      processRevalidation().catch((err) => {
        console.error('[revalidate] Failed:', err);
      }),
    );
    return json({ accepted: true }, 202);
  },
);
