// The ask's per-document state as pure decisions: the access a document
// starts with, what a URL arriving somewhere means for a plan, what the box
// offers, and the prefix the offer stands on. The route only wires these to
// React, so the rules are tested rather than read.

import { type AppliedAsk, parseApplied } from './applied-store';
import type { AskRanking } from './ask-loader';
import type { EmptyReason } from './ask-loader';

/** Whether this document may ask: known at mount from the owner hint the server sets (lib/ask/access-hint). */
export type AskAccess = 'open' | 'off';

/** How the ask is going, as the box and the no-results message show it; an empty answer carries why. */
export type AskProgress =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'unavailable' }
  | { status: 'empty'; reason: EmptyReason };

/** What the no-results message says about asking the text as a question: the offer, the wait, or why nothing came. `keyboard` says the offer can name Enter; a touch device taps the arrow. */
export type AskHint =
  | { status: 'eligible' | 'pending' | 'unavailable'; keyboard: boolean }
  | { status: 'empty'; reason: EmptyReason; keyboard: boolean };

/** What the box shows of the ask: a running question, an applied plan, or nothing. */
export type AskBoxMode = 'off' | 'pending' | 'on';

/** The access a document starts with: the readable hint the owner cookie leaves beside itself opens it, so an owner is open from the first render and nobody else ever mints to find out. */
export function initialAskAccess(hint: boolean): AskAccess {
  return hint ? 'open' : 'off';
}

// The plan rides on the router's own history state, as its docs have it, so
// the entry the ask produced restores it by itself: on Forward, on Back onto
// it, on a reload. router-core already declares its internals there, so an
// undeclared field would share nothing with the type and be refused.
declare module '@tanstack/react-router' {
  interface HistoryState {
    /** The plan an entry the ask produced carries (lib/ask/session). */
    ask?: AppliedAsk;
  }
}

/** The history state a plan's own entry carries: the plan itself. */
export function askEntryState(plan: AppliedAsk): { ask: AppliedAsk } {
  return { ask: plan };
}

/** The plan an entry's history state carries, when the ask produced the entry; null for any other entry. */
export function askEntry(state: unknown): AppliedAsk | null {
  return parseApplied((state as { ask?: unknown } | null | undefined)?.ask);
}

/** The same question: the text and the filters it applied, whatever its ranking became. */
const samePlan = (a: AppliedAsk, b: AppliedAsk): boolean =>
  a.text === b.text && a.mergedKey === b.mergedKey;

/**
 * The ranking the listing is restricted to: the applied plan's while the URL
 * holds its filters, else the one this entry carries while the plan is being
 * restored onto it, so the unrestricted listing never runs under a
 * question's own URL. Nothing before hydration: the server never had the
 * entry, and the first client render must match its HTML.
 */
export function listedRanking({
  applied,
  entry,
  urlKey,
  hydrated,
}: {
  applied: AppliedAsk | null;
  entry: AppliedAsk | null;
  urlKey: string;
  hydrated: boolean;
}): AskRanking | null {
  if (!hydrated) return null;
  if (applied) return applied.mergedKey === urlKey ? applied.ranking : null;
  return entry && entry.mergedKey === urlKey ? entry.ranking : null;
}

/**
 * What the URL arriving somewhere means for the plan. A live plan is its own
 * entry's: `keep` it while this entry carries it (its landing, the entry its
 * about chip rewrote), `end` it on any other entry, whatever the URL's key:
 * another filter set, which the store follows, Back to the typed text, the
 * header logo, a Reset, or another question's own entry (which the next
 * reconcile restores). `restore` the plan an entry the ask produced carries,
 * once the URL holds its filters (none, for a question that only ranked):
 * Forward or Back onto it, a reload of it, or the stored set or the tab's
 * record re-applied after a company page (the rehydrate carries the record
 * as the entry's state). `discard` the tab's record on any other filter URL:
 * a plan superseded while this page was away (a set applied from /filters)
 * must not come back under a hand-set set that happens to equal it. A bare
 * URL leaves the record alone: the rehydrate re-applies the store or the
 * record next.
 */
export type ReconcileAction = 'keep' | 'end' | 'restore' | 'discard';

/** Decides the action for the URL the page is now on; see ReconcileAction. */
export function reconcileApplied({
  applied,
  hasFilters,
  urlKey,
  entry,
  record,
}: {
  applied: AppliedAsk | null;
  hasFilters: boolean;
  urlKey: string;
  /** The plan this history entry carries, when the ask produced it. */
  entry: AppliedAsk | null;
  /** The tab's record, when there is one. */
  record: AppliedAsk | null;
}): ReconcileAction {
  if (applied) return entry && samePlan(entry, applied) ? 'keep' : 'end';
  if (entry) return entry.mergedKey === urlKey ? 'restore' : 'keep';
  return hasFilters && record ? 'discard' : 'keep';
}

/**
 * Whether the box offers to ask, and what the no-results message says. An
 * applied plan or closed access say nothing. A running ask outranks the
 * offer, and the ask's own empty or failed answer outranks it too, so the
 * message explains the answer before the box offers the text again.
 */
export function deriveAskHint({
  applied,
  access,
  progress,
  couldAsk,
  keyboard,
}: {
  applied: boolean;
  access: AskAccess;
  progress: AskProgress;
  couldAsk: boolean;
  keyboard: boolean;
}): { eligible: boolean; hint: AskHint | null } {
  if (applied || access !== 'open') return { eligible: false, hint: null };
  const eligible = progress.status !== 'pending' && couldAsk;
  if (progress.status !== 'idle')
    return { eligible, hint: { ...progress, keyboard } };
  return { eligible, hint: eligible ? { status: 'eligible', keyboard } : null };
}

/** The mode the box shows: pending while a question runs, or a further slice of an applied plan's answer is judged; on while its plan is otherwise applied; else off. */
export function askBoxMode({
  applied,
  progress,
  judging = false,
}: {
  applied: boolean;
  progress: AskProgress;
  judging?: boolean;
}): AskBoxMode {
  if (applied) return judging ? 'pending' : 'on';
  return progress.status === 'pending' ? 'pending' : 'off';
}

/**
 * The prefix the offer stands on, kept at its shortest while the offer holds:
 * a text that only adds to it keeps the offer up through its own search.
 * Forgotten once a text has settled some other way (shortened, cleared, a
 * plan applied, rows found); unchanged while one loads, or while an ask of
 * it runs.
 */
export function nextEmptyPrefix(
  prefix: string | null,
  {
    eligible,
    loading,
    search,
  }: { eligible: boolean; loading: boolean; search: string },
): string | null {
  if (eligible)
    return prefix !== null && search.startsWith(prefix) ? prefix : search;
  return loading ? prefix : null;
}
