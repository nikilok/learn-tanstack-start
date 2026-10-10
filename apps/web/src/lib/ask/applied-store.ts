// The question that produced the listing, kept for this tab so that coming
// back from a company page restores it: the text in the box, the chips, and
// the hand-set filters that clearing it brings back. The filters themselves
// live in the URL and the durable store like any applied set.

import {
  canonicalSearchParams,
  type SearchUrlParams,
} from '@ss/search-filters';

import type { AskRanking } from './ask-loader';
import { rankedIds } from './ranked-ids';

const STORAGE_KEY = 'ss-ask';

/** A plan as it applied: the question, the filters set by hand before it, the merged set's key, its chips, and pathway B's ranking when the question said what the organisations do. */
export type AppliedAsk = {
  text: string;
  base: SearchUrlParams;
  mergedKey: string;
  chips: string[];
  ranking: AskRanking | null;
};

/** A value as a ranking: a span and company ids in rank order, as the listing accepts them; null when it is not one. */
function parseRanking(value: unknown): AskRanking | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<AskRanking>;
  const ranked = rankedIds(v.ranked);
  return typeof v.span === 'string' && ranked ? { span: v.span, ranked } : null;
}

/** A value as a plan, the base re-validated through the registry: null when it is not one of ours. */
export function parseApplied(value: unknown): AppliedAsk | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<AppliedAsk>;
  if (
    typeof v.text !== 'string' ||
    typeof v.mergedKey !== 'string' ||
    !Array.isArray(v.chips) ||
    !v.chips.every((chip) => typeof chip === 'string')
  )
    return null;
  // A ranking that is not one is a corrupt record, not a plan without one.
  const ranking = v.ranking == null ? null : parseRanking(v.ranking);
  if (v.ranking != null && ranking === null) return null;
  return {
    text: v.text,
    base: canonicalSearchParams(v.base),
    mergedKey: v.mergedKey,
    chips: v.chips,
    ranking,
  };
}

/** The stored record, re-validated: null when absent, corrupt, or not ours. */
export function loadApplied(): AppliedAsk | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? parseApplied(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Keeps a plan for this tab; storage that is unavailable keeps nothing, and the listing still works from the URL. */
export function saveApplied(applied: AppliedAsk): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(applied));
  } catch {
    /* unavailable: the question is simply not restored on return */
  }
}

/** Forgets the plan: the question was cleared, edited, or its filters left the URL. */
export function clearApplied(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing kept, nothing to forget */
  }
}
