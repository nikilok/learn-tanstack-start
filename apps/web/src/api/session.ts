import { hmrcSkilledWorkers, sessionVisits } from '@ss/db/schema';
import { createServerFn } from '@tanstack/react-start';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db.server';
import {
  recordCompanyVisit,
  type VisitStore,
} from '../lib/session/visits.server';
import { ensureSession } from '../session.server';
import { setRpcCacheControl } from './cache-headers';

/** The live store: one indexed lookup on the company table, then the insert. */
const store: VisitStore = {
  async companyPageExists(slug) {
    const found = await db
      .select({ one: sql<number>`1` })
      .from(hmrcSkilledWorkers)
      .where(eq(hmrcSkilledWorkers.nameSlug, slug))
      .limit(1);
    return found.length > 0;
  },
  async insertVisit(row) {
    await db.insert(sessionVisits).values(row).onConflictDoNothing();
  },
};

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
 * The rule — what counts as a visit, and what is refused — lives in lib/session/visits.server.ts,
 * where it is tested. Every failure is a quiet `{ noted: false }`: the page never depends on
 * this, and the count is a measurement, not a gate.
 */
export const noteCompanyVisit = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => input as { slug: string })
  .handler(async ({ data }): Promise<{ noted: boolean }> => {
    setRpcCacheControl('private, no-store');
    const session = ensureSession();
    if (!session) return { noted: false };
    return { noted: await recordCompanyVisit(session.id, data?.slug, store) };
  });
