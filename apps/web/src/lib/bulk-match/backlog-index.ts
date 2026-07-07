/**
 * Offline candidate generation for the bulk snapshot matcher. Builds hash
 * indexes over the no_match backlog so a single streaming pass over the
 * ~5.5M-row snapshot finds every candidate pair, then delegates the actual
 * verdicts to the SAME pipeline matchers the online resolver uses
 * (matchTierA/A2/B/D) — one source of truth for matching semantics.
 */

import {
  matchesHmrcLocality,
  matchTierA,
  matchTierASquash,
  matchTierB,
  matchTierD,
  MIN_FUZZY_SQUASH_LENGTH,
  MIN_SQUASH_LENGTH,
  squashForComparison,
} from '../hmrc-ch/pipeline.ts';
import {
  isSnapshotActive,
  type SnapshotCompany,
  toCHCandidate,
} from './snapshot-row.ts';

export type BacklogEntry = {
  organisationName: string;
  /** Parsed legal candidate (parseHmrcName), what the matchers compare. */
  legal: string;
  /** squashForComparison(legal) — the exact/fuzzy index key. */
  squash: string;
  townCity: string | null;
  county: string | null;
};

export type OfflineTier = 'A' | 'A2' | 'B' | 'D';

export type OfflineHit = {
  entry: BacklogEntry;
  company: SnapshotCompany;
  tier: OfflineTier;
  score: number;
};

/** First-3-chars block key for the fuzzy index. Edits inside the first three
 *  characters are not recoverable by this blocking — a documented recall
 *  trade-off that keeps the scan O(rows). */
const FUZZY_BLOCK_LENGTH = 3;

export type BacklogIndex = {
  /** squash key → entries (Tier A/A2 via company name, Tier B via previous
   *  names — equal normalised names always share a squash key). */
  exact: Map<string, BacklogEntry[]>;
  /** first-3-of-squash → entries long enough for Tier D. */
  fuzzy: Map<string, BacklogEntry[]>;
};

/** Builds the lookup indexes from the backlog. Entries with degenerate
 *  squash keys (shorter than the block) are exact-only. */
export function buildBacklogIndex(entries: BacklogEntry[]): BacklogIndex {
  const exact = new Map<string, BacklogEntry[]>();
  const fuzzy = new Map<string, BacklogEntry[]>();
  for (const entry of entries) {
    if (entry.squash.length === 0) continue;
    const bucket = exact.get(entry.squash);
    if (bucket) bucket.push(entry);
    else exact.set(entry.squash, [entry]);

    if (entry.squash.length >= MIN_FUZZY_SQUASH_LENGTH) {
      const block = entry.squash.slice(0, FUZZY_BLOCK_LENGTH);
      const fBucket = fuzzy.get(block);
      if (fBucket) fBucket.push(entry);
      else fuzzy.set(block, [entry]);
    }
  }
  return { exact, fuzzy };
}

/**
 * Matches one snapshot company against the backlog indexes. Index lookups
 * only PRE-FILTER; every returned hit passed the real pipeline matcher for
 * its tier. Tier D additionally requires a snapshot-active company whose
 * locality corroborates the sponsor's town/county (same gates as the online
 * resolver).
 */
export function matchSnapshotCompany(
  index: BacklogIndex,
  company: SnapshotCompany,
): OfflineHit[] {
  const hits: OfflineHit[] = [];
  const cand = toCHCandidate(company);
  const nameSquash = squashForComparison(company.name);
  if (nameSquash.length === 0) return hits;

  for (const entry of index.exact.get(nameSquash) ?? []) {
    const a = matchTierA(entry.legal, cand);
    if (a !== null) {
      hits.push({ entry, company, tier: 'A', score: a });
      continue;
    }
    const a2 = matchTierASquash(entry.legal, cand);
    if (a2 !== null) hits.push({ entry, company, tier: 'A2', score: a2 });
  }

  for (const prev of company.previousNames) {
    const prevSquash = squashForComparison(prev);
    if (prevSquash.length === 0) continue;
    // Equal-squash previous names were already claimed by the exact-name
    // path — but only when the squash was long enough for Tier A2 to fire;
    // below MIN_SQUASH_LENGTH the exact path returned nothing, so Tier B
    // must still get its chance.
    if (prevSquash === nameSquash && prevSquash.length >= MIN_SQUASH_LENGTH) {
      continue;
    }
    for (const entry of index.exact.get(prevSquash) ?? []) {
      // matchTierB applies the exact-normalised comparison and the
      // TRADING-AS exclusion; a squash-key hit that fails it is dropped,
      // keeping bulk semantics identical to the online resolver's Tier B.
      const b = matchTierB(entry.legal, cand);
      if (b !== null) hits.push({ entry, company, tier: 'B', score: b });
    }
  }

  if (
    isSnapshotActive(company.status) &&
    nameSquash.length >= MIN_FUZZY_SQUASH_LENGTH
  ) {
    const block = nameSquash.slice(0, FUZZY_BLOCK_LENGTH);
    for (const entry of index.fuzzy.get(block) ?? []) {
      if (entry.squash === nameSquash) continue; // already exact-matched
      if (!matchesHmrcLocality(cand, entry.townCity, entry.county)) continue;
      const d = matchTierD(entry.legal, cand);
      if (d !== null) hits.push({ entry, company, tier: 'D', score: d });
    }
  }

  return hits;
}
