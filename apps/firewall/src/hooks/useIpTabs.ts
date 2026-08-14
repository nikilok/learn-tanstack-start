// Every IP looked up in a session stays open as a tab. Investigating means comparing clients, so
// revisiting one must be instant — re-querying an IP you already pulled is the thing to avoid.

import { useCallback, useEffect, useRef, useState } from 'react';

import { type IpProfile, type Subject, fetchIpProfile } from '../ip-profile';
import type { Window } from '../time-window';
import { errMsg } from '../util';

export type Creds = { projectId: string; teamId: string; token: string };

export type IpTab = {
  subject: Subject;
  window: Window;
  data: IpProfile | null;
  error: string;
  loading: boolean;
};

export type IpTabs = {
  tabs: IpTab[];
  index: number;
  active: IpTab | undefined;
  /** Focus `subject`, fetching only if new — or always when `force`, which a window change needs. */
  open: (subject: Subject, window: Window, force?: boolean) => void;
  /** Re-query the focused tab, keeping the stale profile on screen until the new one lands. Pass a window to re-scope it too — live mode advances every tick, and the tab's stored window would otherwise pin it to the period it was opened in. */
  refresh: (window?: Window) => void;
  /** Open every subject at once, focusing the first new one. Already-open subjects are skipped rather than duplicated, and each tab fetches independently — the observability client's process-wide gate keeps the fan-out from a burst of 429s. */
  openMany: (subjects: Subject[], window: Window) => void;
  /** Move `dir` tabs, wrapping. */
  cycle: (dir: 1 | -1) => void;
  close: () => void;
};

const subjectKey = (s: Subject) => `${s.kind}:${s.value}`;

/** The subjects not already open, in order, with duplicates inside `incoming` collapsed. Opening a tab twice would give one identity two tabs racing the same fetch. */
export function newSubjects(open: Subject[], incoming: Subject[]): Subject[] {
  const seen = new Set(open.map(subjectKey));
  const out: Subject[] = [];
  for (const s of incoming) {
    const k = subjectKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** What to do with a run request for `key`. A forced call carries a NEW window, so dropping it leaves the tab rendering one period under another's label with no error and no retry — it is queued behind the in-flight fetch instead. */
export function runDisposition(
  inFlight: ReadonlySet<string>,
  key: string,
  force: boolean,
): 'run' | 'queue' | 'drop' {
  if (!inFlight.has(key)) return 'run';
  return force ? 'queue' : 'drop';
}

/** Wrapping tab index. Empty list stays at 0 so the caller never indexes past the end. */
export function nextIndex(
  current: number,
  length: number,
  dir: 1 | -1,
): number {
  if (length <= 0) return 0;
  return (current + dir + length) % length;
}

/** Index to focus after closing the tab at `current`. Clamps onto whatever slid into the slot, or the new last tab when the closed one was last. */
export function indexAfterClose(current: number, remaining: number): number {
  return Math.max(0, Math.min(current, remaining - 1));
}

/** Width the ends of a windowed tab bar cost. Exported so the test measures against the same number the layout uses. */
export const ARROW = 2; // '‹ ' / ' ›'

/**
 * The slice of tabs that fits `available` columns, always including `active`. Overflowing the row
 * makes Ink wrap it and the whole bar disappears, so the bar is windowed and the ends are marked.
 */
export function tabWindow(
  widths: number[],
  active: number,
  available: number,
): { start: number; end: number; left: boolean; right: boolean } {
  const n = widths.length;
  if (!n) return { start: 0, end: 0, left: false, right: false };
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= available)
    return { start: 0, end: n, left: false, right: false };

  // Both arrows are budgeted for even when only one shows, so the window does not resize as it
  // slides — a bar that reflows on every tab press is harder to read than one that is stable.
  const budget = Math.max(0, available - ARROW * 2);
  const i = Math.min(Math.max(active, 0), n - 1);
  let start = i;
  let end = i + 1;
  let used = widths[i];
  // Expand outward from the active tab, right first, so it never scrolls out of view.
  for (let grew = true; grew; ) {
    grew = false;
    if (end < n && used + widths[end] <= budget) {
      used += widths[end];
      end++;
      grew = true;
    }
    if (start > 0 && used + widths[start - 1] <= budget) {
      used += widths[start - 1];
      start--;
      grew = true;
    }
  }
  return { start, end, left: start > 0, right: end < n };
}

export function useIpTabs(creds: Creds): IpTabs {
  const [tabs, setTabs] = useState<IpTab[]>([]);
  const [index, setIndex] = useState(0);
  // Keyed by IP, so two tabs can load at once without either clobbering the other's state.
  const inFlight = useRef(new Set<string>());
  // A forced re-profile that arrives mid-fetch, held until the running one lands.
  const queued = useRef(new Map<string, Window>());
  // Bumped when a subject's tab is closed. A fetch that was already running still resolves, and
  // it patches by subject — so without this it would fill a REOPENED tab with the result of a
  // request nobody was waiting for, rendered as though it were current.
  const epoch = useRef(new Map<string, number>());
  // The tab list as it will be, not as it was last drawn. `tabs` is the RENDERED array, so a
  // second call in the same tick still sees the state before the first: two opens focused the
  // first tab, and two opens of the SAME subject both passed the already-open check and made two
  // tabs for one identity. Every call projects onto this, and it is reconciled from the rendered
  // array on each render — so a close cannot leave it drifting.
  const projected = useRef<IpTab[]>([]);
  useEffect(() => {
    projected.current = tabs;
  }, [tabs]);
  // And which of them has focus, for the same reason. `index` is the RENDERED focus, so a close
  // straight after an open read the focus from before it: opening a tab and closing it in one
  // tick removed the PREVIOUS tab instead — the one the operator meant to keep.
  const focusedAt = useRef(0);
  useEffect(() => {
    focusedAt.current = index;
  }, [index]);

  /** Move focus in both the state and the projection, so a later call in the same tick sees it. */
  const focus = useCallback((to: number) => {
    setIndex(to);
    focusedAt.current = to;
  }, []);

  const run = useCallback(
    async function run(
      subject: Subject,
      window: Window,
      force = false,
    ): Promise<void> {
      const key = subjectKey(subject);
      const disposition = runDisposition(inFlight.current, key, force);
      if (disposition !== 'run') {
        // Last one wins: only the newest window is worth running when this finally lands.
        if (disposition === 'queue') queued.current.set(key, window);
        return;
      }
      inFlight.current.add(key);
      // Both sides through the same default. Read raw, a subject that has never been closed has
      // NO entry, so `undefined !== 0` was true for every first lookup — every patch was dropped
      // and the tab sat on "Loading IP profile…" for ever.
      const epochOf = () => epoch.current.get(key) ?? 0;
      const mine = epochOf();
      const patch = (p: Partial<IpTab>) =>
        // Dropped if the tab was closed while this ran: the subject may be open again, and this
        // result belongs to the tab that is gone.
        epochOf() !== mine
          ? undefined
          : // Matched by identity, not index: tabs can be closed or reordered mid-fetch.
            setTabs((prev) =>
              prev.map((t) =>
                subjectKey(t.subject) === key ? { ...t, ...p } : t,
              ),
            );
      patch({ loading: true, error: '' });
      try {
        patch({
          data: await fetchIpProfile(creds, subject, window),
          loading: false,
        });
      } catch (e) {
        patch({ error: errMsg(e), loading: false });
      } finally {
        // Only the current run cleans up. A stale one — the tab was closed and reopened while it
        // was in flight — would otherwise clear the NEW run's in-flight marker and swallow the
        // window queued against it.
        if (epochOf() === mine) {
          inFlight.current.delete(key);
          const next = queued.current.get(key);
          if (next) {
            queued.current.delete(key);
            void run(subject, next, true);
          }
        }
      }
    },
    [creds],
  );

  const open = useCallback(
    (subject: Subject, window: Window, force = false) => {
      // Already open: switching to it is the whole point, so do not re-query. Use R to refresh.
      // Against the projection, so a subject opened earlier in this same tick counts as open.
      const existing = projected.current.findIndex(
        (t) => subjectKey(t.subject) === subjectKey(subject),
      );
      if (existing !== -1) {
        focus(existing);
        if (force) {
          // The window changed under it, so its data is for a period no longer on screen.
          setTabs((prev) =>
            prev.map((t, i) => (i === existing ? { ...t, window } : t)),
          );
          void run(subject, window, true);
        }
        return;
      }
      const added: IpTab = {
        subject,
        window,
        data: null,
        error: '',
        loading: true,
      };
      setTabs((prev) => [...prev, added]);
      focus(projected.current.length); // where the append lands
      projected.current = [...projected.current, added];
      void run(subject, window);
    },
    [run, focus],
  );

  const openMany = useCallback(
    (subjects: Subject[], window: Window) => {
      const toAdd = newSubjects(
        projected.current.map((t) => t.subject),
        subjects,
      );
      if (!toAdd.length) return;
      const added: IpTab[] = toAdd.map((subject) => ({
        subject,
        window,
        data: null,
        error: '',
        loading: true,
      }));
      setTabs((prev) => [...prev, ...added]);
      focus(projected.current.length); // the first of the appended block
      projected.current = [...projected.current, ...added];
      // Fired together on purpose: `gated` in observability caps concurrent calls process-wide,
      // so these queue rather than stampede, and every tab has its data by the time you reach it.
      for (const s of toAdd) void run(s, window);
    },
    [run, focus],
  );

  const refresh = useCallback(
    (window?: Window) => {
      // From the projection: a refresh straight after an open re-queried the PREVIOUS tab.
      const at = focusedAt.current;
      const t = projected.current[at];
      if (!t) return;
      if (window)
        setTabs((prev) =>
          prev.map((x, i) => (i === at ? { ...x, window } : x)),
        );
      void run(t.subject, window ?? t.window, Boolean(window));
    },
    [run],
  );

  const cycle = useCallback(
    (dir: 1 | -1) => {
      focus(nextIndex(focusedAt.current, projected.current.length, dir));
    },
    [focus],
  );

  const close = useCallback(() => {
    // Forget the closed tab's request state, or reopening it is dropped as a duplicate of a
    // fetch nothing is waiting for any more.
    const at = focusedAt.current;
    const going = projected.current[at];
    if (going) {
      const key = subjectKey(going.subject);
      inFlight.current.delete(key);
      queued.current.delete(key);
      epoch.current.set(key, (epoch.current.get(key) ?? 0) + 1);
    }
    // Computed OUTSIDE the updater: React may invoke an updater twice, and a state setter called
    // from within one is a side effect it is not allowed to have.
    const remaining = projected.current.filter((_, i) => i !== at);
    setTabs((prev) => prev.filter((_, i) => i !== at));
    // The projection drops it too, or a close followed by an open in the same tick appends past
    // the end and focuses a tab that is not there.
    projected.current = remaining;
    focus(indexAfterClose(at, remaining.length));
  }, [focus]);

  return {
    tabs,
    index,
    active: tabs[index],
    open,
    openMany,
    refresh,
    cycle,
    close,
  };
}
