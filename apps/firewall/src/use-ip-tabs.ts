// Every IP looked up in a session stays open as a tab. Investigating means comparing clients, so
// revisiting one must be instant — re-querying an IP you already pulled is the thing to avoid.

import { useCallback, useRef, useState } from 'react';

import { type IpProfile, type Subject, fetchIpProfile } from './ip-profile';
import type { Window } from './time-window';
import { errMsg } from './util';

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
  /** Focus `ip`, fetching only if it is new. An IP already open is switched to, never refetched. */
  /** Focus `subject`, fetching only if new — or always when `force`, which a window change needs. */
  open: (subject: Subject, window: Window, force?: boolean) => void;
  /** Re-query the focused tab, keeping the stale profile on screen until the new one lands. Pass a window to re-scope it too — live mode advances every tick, and the tab's stored window would otherwise pin it to the period it was opened in. */
  refresh: (window?: Window) => void;
  /** Move `dir` tabs, wrapping. */
  cycle: (dir: 1 | -1) => void;
  close: () => void;
};

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

const ARROW = 2; // '‹ ' / ' ›'

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

  const run = useCallback(
    async function run(
      subject: Subject,
      window: Window,
      force = false,
    ): Promise<void> {
      const key = `${subject.kind}:${subject.value}`;
      const disposition = runDisposition(inFlight.current, key, force);
      if (disposition !== 'run') {
        // Last one wins: only the newest window is worth running when this finally lands.
        if (disposition === 'queue') queued.current.set(key, window);
        return;
      }
      inFlight.current.add(key);
      const patch = (p: Partial<IpTab>) =>
        // Matched by identity, not index: tabs can be closed or reordered mid-fetch.
        setTabs((prev) =>
          prev.map((t) =>
            t.subject.kind === subject.kind && t.subject.value === subject.value
              ? { ...t, ...p }
              : t,
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
        inFlight.current.delete(key);
        const next = queued.current.get(key);
        if (next) {
          queued.current.delete(key);
          void run(subject, next, true);
        }
      }
    },
    [creds],
  );

  const open = useCallback(
    (subject: Subject, window: Window, force = false) => {
      // Already open: switching to it is the whole point, so do not re-query. Use R to refresh.
      const existing = tabs.findIndex(
        (t) =>
          t.subject.kind === subject.kind && t.subject.value === subject.value,
      );
      if (existing !== -1) {
        setIndex(existing);
        if (force) {
          // The window changed under it, so its data is for a period no longer on screen.
          setTabs((prev) =>
            prev.map((t, i) => (i === existing ? { ...t, window } : t)),
          );
          void run(subject, window, true);
        }
        return;
      }
      setTabs((prev) => [
        ...prev,
        { subject, window, data: null, error: '', loading: true },
      ]);
      setIndex(tabs.length); // where the append lands
      void run(subject, window);
    },
    [run, tabs],
  );

  const refresh = useCallback(
    (window?: Window) => {
      const t = tabs[index];
      if (!t) return;
      if (window)
        setTabs((prev) =>
          prev.map((x, i) => (i === index ? { ...x, window } : x)),
        );
      void run(t.subject, window ?? t.window, Boolean(window));
    },
    [tabs, index, run],
  );

  const cycle = useCallback(
    (dir: 1 | -1) => setIndex((i) => nextIndex(i, tabs.length, dir)),
    [tabs.length],
  );

  const close = useCallback(() => {
    // Both computed from `tabs`, not from inside the updater: React may invoke an updater twice,
    // and a state setter called from within one is a side effect it is not allowed to have.
    setIndex(indexAfterClose(index, Math.max(0, tabs.length - 1)));
    setTabs((prev) => prev.filter((_, i) => i !== index));
  }, [index, tabs.length]);

  return { tabs, index, active: tabs[index], open, refresh, cycle, close };
}
