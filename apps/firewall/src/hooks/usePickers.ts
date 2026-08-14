// The identity picker: the busiest list for each kind, what the operator typed, and what that
// narrows the list to.

import { type Dispatch, type SetStateAction, useRef, useState } from 'react';

import {
  QUIET_FLOOR,
  busiestCount,
  pickable,
  quietBand,
} from '../identity-list';
import { type Subject, topIps, topJa4 } from '../ip-profile';
import { busiestCap, filterIdentities, type PickKind } from '../pick-input';
import type { Window } from '../time-window';
import type { Creds } from './useIpTabs';
import { type LoadResult, type Pane, usePane } from './usePane';

// The API is asked for 500 groups whatever we pass, so keeping fewer only discards rows already
// paid for. Everything below the top few is what the quiet band is drawn from.
const TOP_IPS_LIMIT = 500;
const MIN_BUSIEST = 10; // busiest rows always shown
// Grows past the minimum while the leaders are still competing. Bounded because the picker eats
// into the pane it sits under, and because every extra row is one more identity to read.
const MAX_BUSIEST = 20;
const QUIET_ROWS = 10; // quiet-band rows shown beside them

export const CAP_BUSIEST = 'busiest';
export const CAP_QUIET = `quietest over ${QUIET_FLOOR}`;
export { TOP_IPS_LIMIT };

export type Pickers = {
  /** Which identity the picker and new tabs address. `i` and `f` set it. */
  kind: PickKind;
  input: string;
  error: string;
  /** -1 means "use what I typed"; 0+ indexes the filtered suggestions, like a URL bar. */
  cursor: number;
  setInput: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  setCursor: Dispatch<SetStateAction<number>>;
  /** Switch which identity new tabs address, without clearing a field the operator is not in. */
  setKind: Dispatch<SetStateAction<PickKind>>;
  /** The list on screen for the current kind. */
  list: Pane<[string, number][]>;
  /** Rows matching the typed filter. */
  filtered: [string, number][];
  /** The busiest column. */
  busiest: [string, number][];
  /** The quiet band beside it — empty under a filter, where it would just repeat the tail. */
  quiet: [string, number][];
  /** Both columns as one flat list, so the cursor, Enter and the screen cannot disagree. */
  pickable: [string, number][];
  /** Reset the field for a fresh lookup of `kind`. */
  begin: (kind: PickKind) => void;
  /** Fetch the list for `kind`. Cached per kind; `force` is required after a window change. */
  load: (creds: Creds, kind: PickKind, window: Window, force?: boolean) => void;
  /** Drop both caches — a window change invalidates them. */
  reset: () => void;
  /** Refetch the visible list for a live tick, reporting what happened so the caller can back off. Reads through refs: the loop is armed once and its closure would otherwise hold whatever was on screen then. */
  refreshLive: (creds: Creds, window: Window) => Promise<LoadResult>;
};

export function usePickers(paneHeight: number): Pickers {
  const [kind, setKind] = useState<PickKind>('ip');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(-1);
  const ipList = usePane<[string, number][]>();
  const ja4List = usePane<[string, number][]>();
  // Read by the live-refresh interval, which must not capture a stale render's values.
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const ipRef = useRef(ipList);
  ipRef.current = ipList;
  const ja4Ref = useRef(ja4List);
  ja4Ref.current = ja4List;

  /** The busiest rows for `want`. One definition, so `load` and `refreshLive` cannot drift. */
  const fetchTop = async (creds: Creds, want: PickKind, window: Window) => {
    const { rows, error: failed } =
      want === 'ip'
        ? await topIps(creds, window, TOP_IPS_LIMIT)
        : await topJa4(creds, window, TOP_IPS_LIMIT);
    if (failed) throw new Error(failed);
    return rows;
  };

  const list = kind === 'ip' ? ipList : ja4List;
  const filtered = filterIdentities(list.data ?? [], input);
  // How many count as busy is a property of the traffic, not a constant: a fixed cut hides the
  // ninth of nine competing leaders.
  const busiest = filtered.slice(
    0,
    busiestCount(
      filtered,
      MIN_BUSIEST,
      busiestCap(paneHeight, QUIET_ROWS, MIN_BUSIEST, MAX_BUSIEST),
    ),
  );
  // Only when browsing. Under a filter the list is already the answer to a question, and a second
  // column drawn from the same matches would just repeat its tail. Skips exactly what the busiest
  // column drew, so the two can never overlap as it grows.
  const quiet = input ? [] : quietBand(filtered, busiest.length, QUIET_ROWS);

  return {
    kind,
    input,
    error,
    cursor,
    setInput,
    setError,
    setCursor,
    setKind,
    list,
    filtered,
    busiest,
    quiet,
    pickable: pickable(busiest, quiet),
    begin: (next) => {
      setKind(next);
      setInput('');
      setError('');
      setCursor(-1);
    },
    load: (creds, want, window, force = false) => {
      const cache = want === 'ip' ? ipList : ja4List;
      if (cache.data && !force) return;
      void cache.load(() => fetchTop(creds, want, window));
    },
    reset: () => {
      ipList.reset();
      ja4List.reset();
    },
    refreshLive: (creds, window) => {
      // Captured once. Read again inside the fetcher, a kind switch mid-tick would put one
      // pane's rows into the other's cache.
      const want = kindRef.current;
      const cache = want === 'ip' ? ipRef.current : ja4Ref.current;
      // No reset(): it clears `data` even when the load below is dropped as a duplicate, which
      // blanks the picker for a tick. A completed load replaces the rows by itself.
      // The outcome comes from load itself: it catches every rejection, so a flag set inside the
      // fetcher cannot see a request the pane dropped as a duplicate, and that reset the backoff
      // to zero on the exact ticks it was supposed to be lengthening.
      return cache.load(() => fetchTop(creds, want, window));
    },
  };
}

/** The subject a picker row names, for the caller to open. */
export type PickerRow = { subject: Subject; count: number };
