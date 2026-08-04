// Every IP looked up in a session stays open as a tab. Investigating means comparing clients, so
// revisiting one must be instant — re-querying an IP you already pulled is the thing to avoid.

import { useCallback, useRef, useState } from 'react';

import { type IpProfile, fetchIpProfile } from './ip-profile';
import type { Window } from './time-window';
import { errMsg } from './util';

export type Creds = { projectId: string; teamId: string; token: string };

export type IpTab = {
  ip: string;
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
  open: (ip: string, window: Window) => void;
  /** Re-query the focused tab, keeping the stale profile on screen until the new one lands. */
  refresh: () => void;
  /** Move `dir` tabs, wrapping. */
  cycle: (dir: 1 | -1) => void;
  close: () => void;
};

/** Wrapping tab index. Empty list stays at 0 so the caller never indexes past the end. */
export function nextIndex(current: number, length: number, dir: 1 | -1): number {
  if (length <= 0) return 0;
  return (current + dir + length) % length;
}

/** Index to focus after closing the tab at `current`. Clamps onto whatever slid into the slot, or the new last tab when the closed one was last. */
export function indexAfterClose(current: number, remaining: number): number {
  return Math.max(0, Math.min(current, remaining - 1));
}

export function useIpTabs(creds: Creds): IpTabs {
  const [tabs, setTabs] = useState<IpTab[]>([]);
  const [index, setIndex] = useState(0);
  // Keyed by IP, so two tabs can load at once without either clobbering the other's state.
  const inFlight = useRef(new Set<string>());

  const run = useCallback(
    async (ip: string, window: Window) => {
      if (inFlight.current.has(ip)) return;
      inFlight.current.add(ip);
      const patch = (p: Partial<IpTab>) =>
        // Matched by IP, not index: tabs can be closed or reordered while a fetch is in flight.
        setTabs((prev) =>
          prev.map((t) => (t.ip === ip ? { ...t, ...p } : t)),
        );
      patch({ loading: true, error: '' });
      try {
        patch({ data: await fetchIpProfile(creds, ip, window), loading: false });
      } catch (e) {
        patch({ error: errMsg(e), loading: false });
      } finally {
        inFlight.current.delete(ip);
      }
    },
    [creds],
  );

  const open = useCallback(
    (ip: string, window: Window) => {
      // Already open: switching to it is the whole point, so do not re-query. Use R to refresh.
      const existing = tabs.findIndex((t) => t.ip === ip);
      if (existing !== -1) {
        setIndex(existing);
        return;
      }
      setTabs((prev) => [
        ...prev,
        { ip, window, data: null, error: '', loading: true },
      ]);
      setIndex(tabs.length); // where the append lands
      void run(ip, window);
    },
    [run, tabs],
  );

  const refresh = useCallback(() => {
    const t = tabs[index];
    if (t) void run(t.ip, t.window);
  }, [tabs, index, run]);

  const cycle = useCallback(
    (dir: 1 | -1) => setIndex((i) => nextIndex(i, tabs.length, dir)),
    [tabs.length],
  );

  const close = useCallback(() => {
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setIndex(indexAfterClose(index, next.length));
      return next;
    });
  }, [index]);

  return { tabs, index, active: tabs[index], open, refresh, cycle, close };
}
