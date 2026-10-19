/**
 * Splitting search discovery across parallel workers.
 *
 * Each worker owns a fixed slice of the undiscovered set, picked in SQL by a
 * hash of the company number, so no two workers search (and pay for) the same
 * company. No claims table: a company's website row already records that it
 * was searched.
 */

/** One worker's slice: bucket `index` of `count`. */
export type Shard = { index: number; count: number };

/** The whole set, as a single worker. */
export const WHOLE_SET: Shard = { index: 0, count: 1 };

/** Most workers one run may split into, to keep shared directory hosts at a polite rate. */
export const MAX_SHARDS = 16;

/** Credits one worker may spend, whatever it is asked for. */
export const MAX_SEARCHES_PER_WORKER = 5000;

/** Credits all the workers of one split may spend together. */
export const MAX_SEARCHES_PER_RUN = 30_000;

/** Parses `--shard=K/N`; absent means the whole set, anything malformed throws. */
export function parseShard(raw: string | undefined): Shard {
  if (raw === undefined) return WHOLE_SET;
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid shard="${raw}" — expected K/N, e.g. 3/12`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || count > MAX_SHARDS) {
    throw new Error(`Invalid shard="${raw}" — N must be 1 to ${MAX_SHARDS}`);
  }
  if (index >= count) {
    throw new Error(`Invalid shard="${raw}" — K must be 0 to N-1`);
  }
  return { index, count };
}

/** Search ceiling for one worker, sized so a whole split stays under MAX_SEARCHES_PER_RUN. */
export function workerSearchCeiling(shard: Shard): number {
  return Math.min(
    MAX_SEARCHES_PER_WORKER,
    Math.floor(MAX_SEARCHES_PER_RUN / shard.count),
  );
}
