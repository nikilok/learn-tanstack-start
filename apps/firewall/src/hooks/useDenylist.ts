// The bans pane's state: what this session staged or lifted, and the activity behind each ban.

import { fileURLToPath } from 'node:url';

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
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

/** A digest denied off the challenge tier this session, and whether the tier was only staged to hold it. */
type Promotion = { value: string; fromStage: boolean };

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
  //
  // `fromStage` is the whole reason this is not a bare list of digests. A promotion off a LIVE
  // tier entry removes something the WAF is enforcing; a promotion off a stage made this session
  // only cancels a pending addition. The two need opposite treatment on both sides — what the
  // rule marker counts, and what a later lift restores — and the distinction is destroyed the
  // moment the stage is cleared, so it is recorded here rather than derived later.
  const [promoted, setPromoted] = useState<Promotion[]>([]);

  // ONE advancing snapshot of the edit buffer.
  //
  // Every guard and every derivation in this hook — validity, already-denied, already-challenged,
  // promotes(), cancels-a-lift — used to read RENDERED state while the writes went through
  // updaters, so within a single tick the reads and the writes described different revisions.
  // Seven defects came out of that, the worst of them leaving a digest on NEITHER tier.
  //
  // Each ref is re-synced from its state on EVERY render, which is the part an earlier attempt
  // got wrong: refs seeded once and only advanced by the setters drift the moment anything else
  // changes the state. Assigning on render means the ref runs ahead within a tick and is pulled
  // back into line by the next render, so reads and writes always see one revision.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const promotedRef = useRef(promoted);
  promotedRef.current = promoted;
  const stagedChallengeRef = useRef(stagedChallenge);
  stagedChallengeRef.current = stagedChallenge;
  const removedChallengeRef = useRef(removedChallenge);
  removedChallengeRef.current = removedChallenge;

  /** Advance items in the snapshot and in state together, so the next call this tick sees it. */
  const commitItems = (next: Item[]) => {
    itemsRef.current = next;
    setItems(next);
  };
  /** Same for the challenge lists — a lift and its re-stage in one tick must see each other. */
  const commitChallenge = (staged: string[], removed: string[]) => {
    stagedChallengeRef.current = staged;
    removedChallengeRef.current = removed;
    setStagedChallenge(staged);
    setRemovedChallenge(removed);
  };

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
  // Only a promotion off a LIVE tier entry takes anything off the rule. One off a stage made this
  // session cancels a pending addition and leaves the tier where it started, so counting it drew
  // −1 for a digest the tier never held and marked a rule the apply would not change.
  const offTier = promoted.filter((p) => !p.fromStage).map((p) => p.value);
  const pending = pendingByRule(
    items,
    staged,
    removed,
    offTier,
    stagedChallenge,
    removedChallenge,
  );

  const stageChallenge = (digest: string): string | undefined => {
    const next = stage(itemsRef.current, 'challenge', digest);
    if (next.error) return next.error;
    // Through an updater, like stageDeny: assigned from the render-time list, a challenge staged
    // in the same tick as another edit overwrote it.
    commitItems(next.items);
    const v = normalizeStaged(digest);
    // Cancelling a pending lift is not a new stage — the digest was live on the tier before and
    // is live after, so NOTHING is pending. afterStage draws exactly this distinction for the
    // deny lists; dropping only the removal left a bare +1 on a rule back where it started.
    const cancelsLift = removedChallengeRef.current.includes(v);
    commitChallenge(
      cancelsLift
        ? stagedChallengeRef.current
        : [...new Set([...stagedChallengeRef.current, v])],
      cancelsLift
        ? removedChallengeRef.current.filter((x) => x !== v)
        : removedChallengeRef.current,
    );
    onEdit();
    return undefined;
  };

  const stageDeny = (kind: DenyKind, value: string): string | undefined => {
    if (kind === 'challenge') return stageChallenge(value);
    // Checked against the rendered items — the refusal has to be returned to the caller, and a
    // state updater cannot return anything.
    const next = stage(itemsRef.current, kind, value);
    if (next.error) return next.error;
    // But APPLIED through an updater, re-running the same pure function against whatever the
    // queue already holds. Computed from the render-time list, two edits in one tick both started
    // from the same snapshot and the second overwrote the first — a staged deny silently gone,
    // with the pane showing it and the apply never writing it.
    commitItems(next.items);
    setEdits((e) => afterStage(e.staged, e.removed, value));
    if (next.promoted) {
      const v = next.promoted;
      // Read BEFORE the stage is cleared below, because clearing it is what destroys the answer.
      const fromStage = stagedChallengeRef.current.includes(v);
      const record = (p: Promotion[]) => [
        ...p.filter((x) => x.value !== v),
        { value: v, fromStage },
      ];
      promotedRef.current = record(promotedRef.current);
      setPromoted(record);
      // A promotion takes the digest OFF the challenge rule, so a stage of it this session is no
      // longer pending — left in place, one digest drew two rows and marked the tier +1 for
      // something it no longer holds.
      commitChallenge(
        stagedChallengeRef.current.filter((x) => x !== v),
        removedChallengeRef.current,
      );
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
    const promotion = promotedRef.current.find((p) => p.value === v);
    commitItems(
      unstage(itemsRef.current, entry.kind, entry.value, Boolean(promotion)),
    );
    if (promotion) {
      promotedRef.current = promotedRef.current.filter((x) => x.value !== v);
      setPromoted((p) => p.filter((x) => x.value !== v));
    }
    if (entry.kind === 'challenge') {
      const v = normalizeStaged(entry.value);
      // A lift of something STAGED this session just drops the stage; only a live one is a
      // removal, the same distinction afterUnstage draws for the deny lists.
      commitChallenge(
        stagedChallengeRef.current.filter((x) => x !== v),
        entry.staged
          ? removedChallengeRef.current
          : [...new Set([...removedChallengeRef.current, v])],
      );
    } else {
      setEdits((e) => afterUnstage(e.staged, e.removed, entry));
      // A promotion off a stage made this session goes back to being that stage. `unstage` puts
      // the digest back on the rule either way, but restoring the RULE without restoring the
      // STAGE left nothing pending: the pane drew it as live and applied, and the apply took its
      // early return and wrote nothing — the digest ending up on no tier at all. A promotion off
      // a LIVE entry needs none of this, because the tier is already back where it started.
      if (promotion?.fromStage)
        commitChallenge(
          [...new Set([...stagedChallengeRef.current, v])],
          removedChallengeRef.current,
        );
    }
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
        stagedChallenge.length ||
        removedChallenge.length,
      ),
      dryRun,
      write: writeEnv,
    });
    if (out.clearStaged) {
      setEdits({ staged: [], removed: [] });
      setPromoted([]);
      // The REF too, not just the state. Left holding applied promotions, a later lift restores a
      // challenge the apply already wrote — putting a digest back on a tier it is no longer on.
      promotedRef.current = [];
      commitChallenge([], []);
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
