// The watch and ignore panes: two lists on disk, loaded, moved between and removed from.

import { useState } from 'react';

import type { Subject } from '../ip-profile';
import {
  IGNORELIST_FILE,
  type ListSide,
  WATCHLIST_FILE,
  type WatchlistEntry,
  afterMove,
  clampCursor,
  filesFor,
  loadError,
  moveNote,
  readList,
  recordExclusive,
  removeEntry,
  saveList,
  withListLock,
} from '../watchlist';

export type ListState = {
  entries: WatchlistEntry[];
  /** Blank when the file read cleanly. Unreadable is distinct from empty. */
  error: string;
  cursor: number;
  /** The row the cursor is on, if any. */
  current: WatchlistEntry | undefined;
};

export type IdentityLists = {
  watch: ListState;
  ignore: ListState;
  /** Re-read a list from disk. Always re-read rather than caching: the watch tick and the CLI both write these files. */
  load: (side: ListSide) => Promise<void>;
  /** Put an identity on one list and off the other. Returns what to tell the operator. */
  move: (to: ListSide, subject: Subject, note: string) => Promise<string>;
  /** Drop the row under the cursor. Returns a message only when the save failed. */
  removeAtCursor: (side: ListSide) => Promise<string | undefined>;
  moveCursor: (side: ListSide, dir: 1 | -1) => void;
  /** Replace the watch list wholesale — the watch loop appends to it as it screens. */
  replaceWatch: (entries: WatchlistEntry[]) => void;
};

export function useIdentityLists(root: string): IdentityLists {
  const [watchEntries, setWatchEntries] = useState<WatchlistEntry[]>([]);
  const [watchError, setWatchError] = useState('');
  const [watchCursor, setWatchCursor] = useState(0);
  const [ignoreEntries, setIgnoreEntries] = useState<WatchlistEntry[]>([]);
  const [ignoreError, setIgnoreError] = useState('');
  const [ignoreCursor, setIgnoreCursor] = useState(0);

  const entriesOf = (side: ListSide) =>
    side === 'watch' ? watchEntries : ignoreEntries;
  const cursorOf = (side: ListSide) =>
    side === 'watch' ? watchCursor : ignoreCursor;
  const setEntries = (side: ListSide, next: WatchlistEntry[]) =>
    (side === 'watch' ? setWatchEntries : setIgnoreEntries)(next);
  const setCursor = (side: ListSide, next: number) =>
    (side === 'watch' ? setWatchCursor : setIgnoreCursor)(next);

  const load = async (side: ListSide) => {
    const file = side === 'watch' ? WATCHLIST_FILE : IGNORELIST_FILE;
    const list = await readList(root, file);
    setEntries(side, list.entries);
    (side === 'watch' ? setWatchError : setIgnoreError)(loadError(list));
    setCursor(side, clampCursor(cursorOf(side), list.entries.length));
  };

  const move = async (to: ListSide, subject: Subject, note: string) => {
    const { add, drop } = filesFor(to);
    const out = await recordExclusive(
      root,
      add,
      drop,
      [{ kind: subject.kind, id: subject.value, source: 'manual', note }],
      new Date(),
    );
    if (out.error) {
      // The add file is written BEFORE the drop, so a half-move has already changed disk while
      // the panes still show the pre-move state. Re-read both so they tell the truth — the same
      // discipline removeAtCursor follows when its save fails.
      await Promise.all([load('watch'), load('ignore')]);
      return `${to} list: ${out.error}`;
    }
    const next = afterMove(to, out.added ?? [], out.remaining ?? []);
    setWatchEntries(next.watch);
    setIgnoreEntries(next.ignore);
    setWatchError('');
    setIgnoreError('');
    setWatchCursor(clampCursor(watchCursor, next.watch.length));
    setIgnoreCursor(clampCursor(ignoreCursor, next.ignore.length));
    return moveNote(to, subject.value);
  };

  const removeAtCursor = async (side: ListSide) => {
    const entry = entriesOf(side)[cursorOf(side)];
    if (!entry) return undefined;
    const file = side === 'watch' ? WATCHLIST_FILE : IGNORELIST_FILE;
    // Dropped from the pane straight away — the removal must feel immediate.
    const shown = removeEntry(entriesOf(side), entry.kind, entry.id);
    setEntries(side, shown);
    // Clamped against the array just computed. entriesOf() still reads PRE-removal state here,
    // so `length - 1` was only ever right while the entry was certain to be found.
    setCursor(side, clampCursor(cursorOf(side), shown.length));
    // But SAVED from a fresh read, not from what the pane had. The watch tick appends to this
    // same file on its own timer, and writing the in-memory list back would drop whatever it
    // added since this pane last loaded. Under the shared lock, so the read and the write are
    // one step and a tick cannot land between them.
    const outcome = await withListLock(async () => {
      const latest = await readList(root, file);
      if (!latest.ok)
        // Unreadable is not empty. Saving the in-memory list over a file we could not read is
        // how a hand edit gets destroyed — the same reason parseWatchlist refuses a partial load.
        return { error: `${latest.error ?? 'unreadable'} — nothing removed` };
      const next = removeEntry(latest.entries, entry.kind, entry.id);
      const err = await saveList(root, file, next);
      return err ? { error: err } : { next };
    });
    // What was SAVED is what the pane should show: the late read may carry entries the watch
    // tick appended since this pane last loaded.
    if (outcome.next) {
      setEntries(side, outcome.next);
      setCursor(side, clampCursor(cursorOf(side), outcome.next.length));
      return undefined;
    }
    // The file still holds what the pane just dropped — re-read so the two agree.
    await load(side);
    return `${side} list: ${outcome.error}`;
  };

  return {
    watch: {
      entries: watchEntries,
      error: watchError,
      cursor: watchCursor,
      current: watchEntries[watchCursor],
    },
    ignore: {
      entries: ignoreEntries,
      error: ignoreError,
      cursor: ignoreCursor,
      current: ignoreEntries[ignoreCursor],
    },
    load,
    move,
    removeAtCursor,
    moveCursor: (side, dir) =>
      setCursor(
        side,
        clampCursor(cursorOf(side) + dir, entriesOf(side).length),
      ),
    replaceWatch: (entries) => {
      setWatchEntries(entries);
      setWatchError('');
    },
  };
}
