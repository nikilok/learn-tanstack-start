/**
 * POST /api/revalidate
 *
 * Invalidates Vercel CDN cache for company pages whose data has changed.
 * Called by ch-stream (Railway) after processing Companies House stream events.
 *
 * Auth:    x-revalidate-secret header (timing-safe comparison)
 * Response: unauthenticated callers always get a neutral 202 (no auth signal).
 *           Authenticated: the trail drain answers 202 and runs async; ?purge
 *           is awaited — 200 {purged} on success, 400 on a non-whitelisted
 *           value, 500 on API failure so the sweep workflow's curl -f goes red
 *
 * Behaviour:
 *  - ?purge=company-pages: awaited invalidation of the population tag instead
 *    of draining trails — the sweep workflow's nightly call after promotions
 *  - Reads a cursor from companies_house_profile_cache to find new trail entries
 *  - Builds cache tags (company-{number}) for each changed company
 *  - VERCEL_CACHE_INVALIDATION=true:  calls Vercel SDK invalidateByTags, advances cursor
 *  - VERCEL_CACHE_INVALIDATION=false: logs tags (dry-run), cursor unchanged
 *  - On trail-purge failure: cursor is NOT advanced, so next call retries
 *
 * Env vars (Vercel):
 *  - REVALIDATE_SECRET          — shared secret with ch-stream
 *  - VERCEL_CACHE_INVALIDATION  — 'true' to enable live purging
 *  - VERCEL_API_TOKEN           — Vercel API token for SDK auth
 *  - VERCEL_PROJECT_ID          — Vercel project to purge cache for
 */
import {
  companiesHouseProfileCache,
  companiesHouseProfileTrails,
} from '@ss/db/schema';
import { waitUntil } from '@vercel/functions';
import { eq, gt, max } from 'drizzle-orm';

import { ALL_COMPANY_PAGES_TAG, companyTag } from '#/api/cache-tags';
import { db } from '#/db.server';

import {
  invalidateTagsIfLive,
  TAG_BATCH_SIZE,
} from '../utils/invalidateTags.ts';
import { json, withSecret } from '../utils/withSecret.ts';

/** Nightly population purge; false = dry-run (invalidation off). Throws on API failure so the endpoint can 500. */
async function processCompanyPagesPurge(): Promise<boolean> {
  const purged = await invalidateTagsIfLive([ALL_COMPANY_PAGES_TAG]);
  console.log(
    purged
      ? `[revalidate] Invalidated ${ALL_COMPANY_PAGES_TAG}`
      : `[revalidate:dry-run] Would invalidate ${ALL_COMPANY_PAGES_TAG}`,
  );
  return purged;
}

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
  const tags = trails.map((t) => companyTag(t.companyNumber));

  if (!(await invalidateTagsIfLive(tags))) {
    console.log(
      `[revalidate:dry-run] Would invalidate ${tags.length} tags: ${tags.join(', ')}`,
    );
    return;
  }

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
  async (event) => {
    // Fixed whitelist, never input: the secret holder cannot purge arbitrary
    // tags through this endpoint.
    const purge = new URL(event.req.url).searchParams.get('purge');
    if (purge !== null) {
      if (purge !== ALL_COMPANY_PAGES_TAG) {
        return json({ accepted: false }, 400);
      }
      // Awaited, unlike the trail drain: one invalidateByTags call is fast,
      // and a throw must surface as a 500 so the sweep workflow's curl -f
      // turns the step red instead of burying the failure in function logs.
      return json({ purged: await processCompanyPagesPurge() }, 200);
    }
    waitUntil(
      processRevalidation().catch((err) => {
        console.error('[revalidate] Failed:', err);
      }),
    );
    return json({ accepted: true }, 202);
  },
);
