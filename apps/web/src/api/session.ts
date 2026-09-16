import { sessionVisits } from '@ss/db/schema';
import { createServerFn } from '@tanstack/react-start';

import { db } from '../db.server';
import { hourBucket } from '../lib/session/token.server';
import { ensureSession } from '../session.server';
import { slugify } from '../utils';
import { setRpcCacheControl } from './cache-headers';

/**
 * Records that the visitor's session viewed a company page: one row per (session, slug, UTC
 * hour), so "distinct company pages per session per hour" is a count. Called from the company
 * page component on mount — hydration and every client navigation alike — which is what makes
 * it a navigation count and not a request count: a hover preload never mounts anything, and
 * the edge-cached document never runs a loader for it.
 *
 * It is also where the session cookie is issued, because an RPC response is the one place a
 * `Set-Cookie` costs nothing: on a document it would stop the edge caching that page.
 *
 * Every failure is a quiet `{ noted: false }`: the page never depends on this, and the count
 * is a measurement, not a gate.
 */
export const noteCompanyVisit = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => input as { slug: string })
  .handler(async ({ data }): Promise<{ noted: boolean }> => {
    setRpcCacheControl('private, no-store');
    const session = ensureSession();
    if (!session) return { noted: false };
    // Same guard as getHmrcCompanyBySlug: the payload is caller-controlled, and only a
    // canonical slug is a page that exists to have been visited.
    const slug = typeof data?.slug === 'string' ? slugify(data.slug) : '';
    if (!/^[a-z0-9-]{1,255}$/.test(slug)) return { noted: false };
    try {
      await db
        .insert(sessionVisits)
        .values({ sessionId: session.id, slug, hour: hourBucket(Date.now()) })
        .onConflictDoNothing();
      return { noted: true };
    } catch (err) {
      console.error('[session] visit not recorded', err);
      return { noted: false };
    }
  });
