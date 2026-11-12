// A question's ranking as the slices it was judged in (lib/ask/session has
// the state rules): the engine judges RANKED_MAX companies of the question's
// shortlist at a time, and a listing that has shown one slice asks for the
// next when the visitor reaches its end. The rules are pure; the route and
// the listing hook only wire them.

import type { AskRanking } from './ask-loader';
import { RANKED_MAX } from './ranked-ids';

/** Slices judged for one question at most, so a broad question's walk is bounded in cost: 8,000 candidates. */
export const TRANCHES_MAX = 20;

/** Dry slices in a row (nobody at or over the closest band) that end a walk early: the shortlist's order front-loads the likeliest, so a run this long means the tail is dry. */
export const EMPTY_TRANCHES_MAX = 3;

/** The offset of the slice after the one judged from `offset`: null when the shortlist ran out (`shortlisted` short of a full slice) or the walk reached its bound. */
export function nextTrancheOffset(
  offset: number,
  shortlisted: number,
): number | null {
  const next = offset + RANKED_MAX;
  if (shortlisted < RANKED_MAX || next >= TRANCHES_MAX * RANKED_MAX)
    return null;
  return next;
}

/** Whether a value is the offset of a slice after the first: a whole multiple of the slice size, under the walk's bound. */
export function isTrancheOffset(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= RANKED_MAX &&
    value < TRANCHES_MAX * RANKED_MAX &&
    value % RANKED_MAX === 0
  );
}

/** One more judged slice: what it found, in rank order, and where the walk goes next. */
export type JudgedTranche = { ranked: string[]; next: number | null };

/**
 * The ranking after one more slice is judged: the companies not already in
 * it appended as a tranche (a slice with none is not appended), the walk
 * moved to the slice's `next`, and ended instead once EMPTY_TRANCHES_MAX
 * slices in a row found nobody. `emptyRun` is the dry slices so far; the new
 * count is returned beside the ranking.
 */
export function extendRanking(
  ranking: AskRanking,
  more: JudgedTranche,
  emptyRun: number,
): { ranking: AskRanking; emptyRun: number } {
  const seen = new Set(ranking.tranches.flat());
  const fresh: string[] = [];
  for (const id of more.ranked) {
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push(id);
  }
  const run = fresh.length ? 0 : emptyRun + 1;
  return {
    ranking: {
      span: ranking.span,
      tranches: fresh.length ? [...ranking.tranches, fresh] : ranking.tranches,
      next: run >= EMPTY_TRANCHES_MAX ? null : more.next,
    },
    emptyRun: run,
  };
}

/** Where one page of the ranked listing's rows sits: the tranche's index and the row offset into it. */
export type RankedPage = { tranche: number; offset: number };

/**
 * The page after `last`: the same tranche's next rows while it has more,
 * else the next tranche's first rows while there is one, else nothing (and
 * the walk may judge another). `shown` is how many rows of `last`'s tranche
 * the pages so far hold.
 */
export function nextRankedPage(
  last: RankedPage,
  {
    hasMore,
    shown,
    tranches,
  }: { hasMore: boolean; shown: number; tranches: number },
): RankedPage | undefined {
  if (hasMore) return { tranche: last.tranche, offset: shown };
  return last.tranche + 1 < tranches
    ? { tranche: last.tranche + 1, offset: 0 }
    : undefined;
}

/** The listing the results list reads while a ranking's walk goes on: a slice with the judge is rows on their way, one that could not be judged is a next page that failed, and a slice still to judge keeps the list open. */
export function walkedListing<
  T extends { hasMore: boolean; loadingMore: boolean; moreFailed: boolean },
>(
  listing: T,
  walk: { next: number | null; judging: boolean; failed: boolean },
): T {
  return {
    ...listing,
    hasMore: listing.hasMore || walk.next !== null,
    loadingMore: listing.loadingMore || walk.judging,
    moreFailed: listing.moreFailed || walk.failed,
  };
}
