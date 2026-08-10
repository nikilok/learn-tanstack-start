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
        // Sorted VALUES = canonical row-lock order, so two overlapping claim
        // statements can never deadlock however their callers ordered input.
        .values(
          [...chunk].sort().map((origin) => ({ origin, claimedBy: workerId })),
        )
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
 * Re-stamp claimed_at on claims this worker still holds, so a long batch's
 * tail never ages past the lease while earlier origins process. Guarded by
 * claimed_by like release: renewing a row another worker now holds is a
 * silent no-op, and the caller finding fewer rows renewed than asked is the
 * signal that a claim was lost.
 */
export function makeRenewClaims(db: Db) {
  return async (workerId: string, origins: string[]): Promise<number> => {
    if (origins.length === 0) return 0;
    const rows = await db
      .update(profileWorkClaims)
      .set({ claimedAt: sql`now()` })
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

/**
 * Release claims this worker holds, by deleting them. The claimed_by guard
 * makes a stale worker's release a no-op: if its lease expired and another
 * worker re-claimed the origin, the row now belongs to that worker and must
 * survive. The guard is only as strong as id uniqueness, so callers must pass
 * a PER-PROCESS instance id, never a shared machine name — two incarnations
 * under one id would pass each other's guard (the harness salts its --claim
 * value with pid + start time for exactly this reason).
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
