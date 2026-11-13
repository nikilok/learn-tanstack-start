// What a planned ask answers with once its span's first slice was judged,
// or could not be. Pure, so the decision is tested apart from the server fn.

import { orderAsked, type SearchUrlParams } from '@ss/search-filters';

import type { AskPlanResponse, EmptyReason } from './ask-loader';
import { nextTrancheOffset } from './tranches';

/** The judged first slice: the companies kept, in rank order, and how many were shortlisted. */
export type JudgedSlice = { ranked: string[]; shortlisted: number };

/** The plan's answer. A slice that kept companies answers with the ranking under the filters. A slice judged that kept none, or nothing to judge under the filters, is `unmatched` with no filters: a listing of the filters alone would pass for the answer. A rerank that failed loses the ranking, not the filters, which still answer; with none to fall back on, nothing can. A plan with no span answers with its filters and its own reason. A sort the question or the base asks for pins the ranking to its first slice: an order cannot be kept over slices judged as the visitor reads, so the walk ends where the order holds. */
export function askOutcome({
  filters,
  base,
  reason,
  span,
  sector,
  slice,
  failed,
}: {
  filters: SearchUrlParams;
  base: SearchUrlParams;
  reason: EmptyReason;
  span: string | null;
  sector: string | null;
  slice: JudgedSlice | null;
  failed: boolean;
}): AskPlanResponse {
  const filtered = Object.keys(filters).length > 0;
  if (failed) {
    return filtered
      ? { status: 'ok', filters, reason, ranking: null }
      : { status: 'unavailable' };
  }
  if (slice && span) {
    if (!slice.ranked.length)
      return { status: 'ok', filters: {}, reason: 'unmatched', ranking: null };
    const sorted = orderAsked(filters) || orderAsked(base);
    return {
      status: 'ok',
      filters,
      reason,
      ranking: {
        span,
        sector,
        tranches: [slice.ranked],
        next: sorted ? null : nextTrancheOffset(0, slice.shortlisted),
      },
    };
  }
  return { status: 'ok', filters, reason, ranking: null };
}
