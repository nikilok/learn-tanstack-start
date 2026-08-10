/**
 * Claim/release factories for distributed extraction work.
 *
 * The origin is the unit of work, profile_work_claims is the coordination
 * point, and the answers ledger stays the source of truth: a lost or expired
 * claim never loses work, it only lets another worker redo an idempotent
 * upsert. Kept as factories rather than harness-inline so the future
 * volunteer API door wraps the SAME claim/release logic — volunteers receive
 * server-held snapshot text keyed by these claims, never URLs to fetch.
 */

import type { createClient } from '@ss/db/client';
import { profileWorkClaims } from '@ss/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

type Db = ReturnType<typeof createClient>;

/**
 * Minutes before an unreleased claim counts as abandoned and claimable again.
 * Long enough that a worker's just-in-time batch (see the harness CLAIM_BATCH)
 * finishes well inside it even at CI speed; short enough that a crashed
 * worker's origins return to the pool within the same run window.
 */
export const CLAIM_LEASE_MINUTES = 30;

/**
 * Claim up to `target` of `candidates` for `workerId`, walking the list in
 * order. One INSERT .. ON CONFLICT (origin) DO UPDATE .. WHERE lease-expired
 * .. RETURNING per chunk: rows another worker holds live conflict without
 * updating and fall out of RETURNING, so the returned origins are exactly the
 * ones this worker now exclusively holds.
 */
export function makeClaimOrigins(db: Db) {
  return async (
    workerId: string,
    candidates: string[],
    target: number,
  ): Promise<string[]> => {
    const won: string[] = [];
    let cursor = 0;
    while (cursor < candidates.length && won.length < target) {
      const chunk = candidates.slice(cursor, cursor + (target - won.length));
      cursor += chunk.length;
      const rows = await db
        .insert(profileWorkClaims)
        .values(chunk.map((origin) => ({ origin, claimedBy: workerId })))
        .onConflictDoUpdate({
          target: profileWorkClaims.origin,
          set: {
            claimedBy: sql`excluded.claimed_by`,
            claimedAt: sql`now()`,
          },
          setWhere: sql`${profileWorkClaims.claimedAt} < now() - make_interval(mins => ${CLAIM_LEASE_MINUTES})`,
        })
        .returning({ origin: profileWorkClaims.origin });
      won.push(...rows.map((row) => row.origin));
    }
    return won;
  };
}

/**
 * Release claims this worker holds, by deleting them. The claimed_by guard
 * makes a stale worker's release a no-op: if its lease expired and another
 * worker re-claimed the origin, the row now belongs to that worker and must
 * survive.
 */
export function makeReleaseClaims(db: Db) {
  return async (workerId: string, origins: string[]): Promise<number> => {
    if (origins.length === 0) return 0;
    const rows = await db
      .delete(profileWorkClaims)
      .where(
        and(
          inArray(profileWorkClaims.origin, origins),
          eq(profileWorkClaims.claimedBy, workerId),
        ),
      )
      .returning({ origin: profileWorkClaims.origin });
    return rows.length;
  };
}
