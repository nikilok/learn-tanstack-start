// The bans pane's state: what this session staged or lifted, and the activity behind each ban.

import { fileURLToPath } from 'node:url';

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from 'react';

import { JA4_DENY, enforcedNow } from '../deny-list';
import { persistDenies } from '../deny-persist';
import {
  type DenyKind,
  type LiveDenies,
  afterStage,
  afterUnstage,
  denyEntries,
  liveDenies,
  isStaged,
  normalizeStaged,
  pendingByRule,
  stage,
  unstage,
} from '../deny-staging';
import { type Activity, fetchDenyActivity } from '../denylist-data';
import type { DenyEntry } from '../denylist-view';
import { persistEnvVar } from '../env-file';
import type { ApplyStatus, Item } from '../seed-items';
import type { Creds } from './useIpTabs';
import { type Pane, usePane } from './usePane';

// Repo root, the single source of truth the denylist rules are rebuilt from on every apply.
// Depth-sensitive, and it broke silently when this file moved into hooks/ — a deny then landed in
// apps/.env.local, so the next apply rebuilt from the untouched root file and LIFTED the ban.
// envPathIsRepoRoot in the test locks it against the next move.
export const ENV_PATH = fileURLToPath(
  new URL('../../../../.env.local', import.meta.url),
);
const DENY_ACTIVITY_HOURS = 144;

export type Denylist = {
  live: LiveDenies;
  entries: DenyEntry[];
  /** Per-rule marker for unapplied edits, keyed by rule name. */
  pending: Map<string, string>;
  cursor: number;
  moveCursor: (dir: 1 | -1) => void;
  activity: Pane<Map<string, Activity>>;
  /** An error that arrived WITH partial data, which usePane.error cannot carry. */
  activityNote: string;
  /** Stage a deny. Returns the refusal message when the value is malformed, never throws. */
  stageDeny: (kind: DenyKind, value: string) => string | undefined;
  unstageDeny: (entry: DenyEntry) => void;
  /** Whether the WAF is denying `digest` right now, as opposed to the local edit buffer. */
  enforcedJa4: (digest: string) => boolean;
  /** Whether `digest` is staged this session and not yet applied. */
  stagedJa4: (digest: string) => boolean;
  /** Whether the live challenge tier is challenging `digest`. */
  challengedJa4: (digest: string) => boolean;
  loadActivity: (creds: Creds) => void;
  /** Write whatever actually landed back to .env.local, and clear the staging only if all of it did. */
  persist: (
    snapshot: Item[],
    outcome: Map<string, ApplyStatus>,
    dryRun: boolean,
  ) => { ok: boolean; summary: string };
};

export function useDenylist(opts: {
  items: Item[];
  setItems: Dispatch<SetStateAction<Item[]>>;
  /** Called on every edit, so the last apply's banner cannot describe stale state. */
  onEdit: () => void;
  /** How a persisted value reaches disk. Injectable so a test can exercise the write path without touching the real .env.local — the file an apply actually rewrites. */
  writeEnv?: (key: string, value: string) => void;
}): Denylist {
  const { items, setItems, onEdit } = opts;
  const writeEnv =
    opts.writeEnv ??
    ((key: string, value: string) => persistEnvVar(ENV_PATH, key, value));
  const [staged, setStaged] = useState<string[]>([]);
  // Unbanned this session: the value is gone from the rule, so it needs its own record to stay
  // on screen as a pending change until applied.
  const [removed, setRemoved] = useState<string[]>([]);
  // Taken off the challenge tier by a promotion, so the rules list can mark that rule too.
  const [promoted, setPromoted] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [activityNote, setActivityNote] = useState('');
  const activity = usePane<Map<string, Activity>>();

  const live = liveDenies(items);
  const entries = denyEntries({
    liveJa4: live.ja4,
    liveAsn: live.asn,
    staged,
    removed,
    activity: activity.data,
  });
  const pending = pendingByRule(items, staged, removed, promoted);

  const stageDeny = (kind: DenyKind, value: string): string | undefined => {
    const next = stage(items, kind, value);
    if (next.error) return next.error;
    setItems(next.items);
    setStaged((s) => afterStage(s, removed, value).staged);
    setRemoved((r) => afterStage(staged, r, value).removed);
    if (next.promoted)
      setPromoted((p) => [...new Set([...p, next.promoted as string])]);
    onEdit();
    return undefined;
  };

  const unstageDeny = (entry: DenyEntry) => {
    // A lifted promotion goes back to the challenge tier it was taken from, or the operator is
    // left with less protection than they started with.
    const wasPromoted = promoted.includes(normalizeStaged(entry.value));
    setItems(unstage(items, entry.kind, entry.value, wasPromoted));
    if (wasPromoted)
      setPromoted((p) => p.filter((v) => v !== normalizeStaged(entry.value)));
    setStaged((s) => afterUnstage(s, removed, entry).staged);
    setRemoved((r) => afterUnstage(staged, r, entry).removed);
    onEdit();
  };

  const loadActivity = useCallback(
    (creds: Creds) => {
      void activity.load(async () => {
        const { activity: found, error } = await fetchDenyActivity(
          creds,
          DENY_ACTIVITY_HOURS,
          live.ja4,
        );
        if (error && !found.size) throw new Error(error);
        // Partial is not complete: a nonempty map with an error behind it must still say so, or
        // a digest missing from it reads as "no traffic — safe to retire".
        setActivityNote(error ?? '');
        return found;
      });
    },
    [activity, live.ja4],
  );

  const persist = (
    snapshot: Item[],
    outcome: Map<string, ApplyStatus>,
    dryRun: boolean,
  ) => {
    const out = persistDenies({
      snapshot,
      outcome,
      pending: Boolean(staged.length || removed.length || promoted.length),
      dryRun,
      write: writeEnv,
    });
    if (out.clearStaged) {
      setStaged([]);
      setRemoved([]);
      setPromoted([]);
    }
    return { ok: out.ok, summary: out.summary };
  };

  return {
    live,
    entries,
    pending,
    // Live-and-applied, NOT merely present in the rule: a staged digest is in the local rule but
    // has not been written, and calling that "already denied" is a lie.
    enforcedJa4: (digest) =>
      enforcedNow(live.ja4, staged, removed, digest, JA4_DENY),
    stagedJa4: (digest) => isStaged(staged, digest),
    // Our own interstitial stops a browser fetching sub-resources, so its rendering evidence
    // disappears — and the advisory must not read that silence as a measured zero.
    challengedJa4: (digest) =>
      live.challenged.some(
        (v) => JA4_DENY.normalize(v) === JA4_DENY.normalize(digest),
      ),
    cursor,
    moveCursor: (dir) =>
      setCursor((c) => Math.max(0, Math.min(entries.length - 1, c + dir))),
    activity,
    activityNote,
    stageDeny,
    unstageDeny,
    loadActivity,
    persist,
  };
}

export { DENY_ACTIVITY_HOURS };
