// The bans pane's state: what this session staged or lifted, and the activity behind each ban.

import { fileURLToPath } from 'node:url';

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
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
  /** Stage a digest onto the RECOVERABLE tier. Returns a refusal to show, or undefined. */
  stageChallenge: (digest: string) => string | undefined;
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
  // ONE piece of state, not two. As separate lists each setter read the OTHER from the render-time
  // closure, so a lift and a re-deny in the same tick disagreed: the removal was cleared while the
  // value stayed staged, leaving `pending` true with nothing actually changed and the apply
  // persisting a cancelled edit. Both now come out of a single transition over the same snapshot.
  const [edits, setEdits] = useState<{ staged: string[]; removed: string[] }>({
    staged: [],
    removed: [],
  });
  const { staged, removed } = edits;
  // Its own list: `staged` is classified by SHAPE downstream, and a challenged digest and a denied
  // one are the same shape — folded together, every staged challenge rendered as a deny.
  const [stagedChallenge, setStagedChallenge] = useState<string[]>([]);
  // And its mirror for lifts. A challenge taken off the tier went onto the shared `removed` list,
  // which is classified by shape — so the pane called it a JA4 removal and the rule marker fired
  // on neither rule, leaving the lift showing as pending nowhere.
  const [removedChallenge, setRemovedChallenge] = useState<string[]>([]);
  // Taken off the challenge tier by a promotion, so the rules list can mark that rule too.
  const [promoted, setPromoted] = useState<string[]>([]);
  // Projected, for the same reason the tab list is: `promoted` is the RENDERED array, so a
  // promotion and its lift in one tick read an empty list and skipped the restore — leaving the
  // digest on NEITHER tier, which is strictly less protection than before the keypress.
  const promotedRef = useRef<string[]>([]);
  useEffect(() => {
    promotedRef.current = promoted;
  }, [promoted]);

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
    stagedChallenge,
    removedChallenge,
    // Live ones the operator has NOT just staged or lifted, or a digest touched this session
    // would appear twice: once as live and once as pending.
    liveChallenge: live.challenged.filter(
      (v) =>
        !stagedChallenge.includes(normalizeStaged(v)) &&
        !removedChallenge.includes(normalizeStaged(v)),
    ),
  });
  const pending = pendingByRule(
    items,
    staged,
    removed,
    promoted,
    stagedChallenge,
    removedChallenge,
  );

  const stageChallenge = (digest: string): string | undefined => {
    const next = stage(items, 'challenge', digest);
    if (next.error) return next.error;
    // Through an updater, like stageDeny: assigned from the render-time list, a challenge staged
    // in the same tick as another edit overwrote it.
    setItems((prev) => stage(prev, 'challenge', digest).items);
    setStagedChallenge((c) => [...new Set([...c, normalizeStaged(digest)])]);
    onEdit();
    return undefined;
  };

  const stageDeny = (kind: DenyKind, value: string): string | undefined => {
    if (kind === 'challenge') return stageChallenge(value);
    // Checked against the rendered items — the refusal has to be returned to the caller, and a
    // state updater cannot return anything.
    const next = stage(items, kind, value);
    if (next.error) return next.error;
    // But APPLIED through an updater, re-running the same pure function against whatever the
    // queue already holds. Computed from the render-time list, two edits in one tick both started
    // from the same snapshot and the second overwrote the first — a staged deny silently gone,
    // with the pane showing it and the apply never writing it.
    setItems((prev) => stage(prev, kind, value).items);
    setEdits((e) => afterStage(e.staged, e.removed, value));
    if (next.promoted) {
      const v = next.promoted;
      promotedRef.current = [...new Set([...promotedRef.current, v])];
      setPromoted((p) => [...new Set([...p, v])]);
    }
    onEdit();
    return undefined;
  };

  const unstageDeny = (entry: DenyEntry) => {
    // A lifted promotion goes back to the challenge tier it was taken from, or the operator is
    // left with less protection than they started with.
    const v = normalizeStaged(entry.value);
    // From the projection, not the render: a promotion staged earlier in this same tick has not
    // reached `promoted` yet, and reading it there loses the restore.
    const wasPromoted = promotedRef.current.includes(v);
    setItems((prev) => unstage(prev, entry.kind, entry.value, wasPromoted));
    if (wasPromoted) {
      promotedRef.current = promotedRef.current.filter((x) => x !== v);
      setPromoted((p) => p.filter((x) => x !== v));
    }
    if (entry.kind === 'challenge') {
      const v = normalizeStaged(entry.value);
      // A lift of something STAGED this session just drops the stage; only a live one is a
      // removal, the same distinction afterUnstage draws for the deny lists.
      setStagedChallenge((c) => c.filter((x) => x !== v));
      if (!entry.staged) setRemovedChallenge((r) => [...new Set([...r, v])]);
    } else setEdits((e) => afterUnstage(e.staged, e.removed, entry));
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
      // stagedChallenge counts as pending like the rest. Left out, a challenge staged on its own
      // took the `!pending` early return: the apply reported success and wrote nothing, which is
      // the same shape of silent failure the deny path has been bitten by twice.
      pending: Boolean(
        staged.length ||
        removed.length ||
        promoted.length ||
        stagedChallenge.length,
      ),
      dryRun,
      write: writeEnv,
    });
    if (out.clearStaged) {
      setEdits({ staged: [], removed: [] });
      setPromoted([]);
      setStagedChallenge([]);
      setRemovedChallenge([]);
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
    // Clamped on READ, not only on move: the entries list shrinks when an apply clears the staged
    // rows, and a cursor left past the end makes `current` undefined — u and x then land on
    // nothing, with nothing on screen saying why.
    cursor: Math.max(0, Math.min(cursor, Math.max(0, entries.length - 1))),
    moveCursor: (dir) =>
      setCursor((c) => Math.max(0, Math.min(entries.length - 1, c + dir))),
    activity,
    activityNote,
    stageDeny,
    stageChallenge,
    unstageDeny,
    loadActivity,
    persist,
  };
}

export { DENY_ACTIVITY_HOURS };
