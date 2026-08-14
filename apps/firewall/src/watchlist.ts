// Operator-curated identity lists, one file format, two opposite meanings. The WATCH list is
// what to keep an eye on — fed automatically by watch mode (every profiled fingerprint) and
// manually from a profile tab. The IGNORE list is curated noise — identities watch mode must
// not profile, record, or display. An identity sits on at most one of them.
//
// Tool-side state only: nothing here touches a WAF rule, so neither lives in .env.local.
// That file is written by deliberate operator action and fingerprinted around investigations to
// alarm on unattended writes; a background tick appending to it would either trip that alarm or
// normalise automation writing the secrets file. These sit with the loop's other state files.
//
// Writers WITHIN a process are serialized by withListLock — the TUI runs the watch tick on a
// timer beside the operator's keystrokes, and those two overlapping is ordinary, not exotic.
// ACROSS processes there is no lock: the tool runs as a single instance, and a CLI run racing a
// TUI can still lose one seen-bump. Tolerated, because saves go through a write-then-rename, so
// the worst case drops a count and never leaves a file half-written.

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

import { errMsg } from './util';

/** Repo root, gitignored. One entry per line: kind|id|addedAt|lastSeen|seen|source|note. */
export const WATCHLIST_FILE = '.firewall-watchlist';
/** Same format, same place. Ignoring is muting, not allowing: the WAF is untouched. */
export const IGNORELIST_FILE = '.firewall-ignorelist';

const KINDS = ['ip', 'ja4'] as const;
const SOURCES = ['watch', 'manual'] as const;
const NOTE_MAX = 300;

export type WatchlistEntry = {
  kind: (typeof KINDS)[number];
  id: string;
  addedAt: string; // ISO
  lastSeen: string; // ISO
  /** Times recorded — for watch-mode adds, the number of ticks that profiled it. */
  seen: number;
  source: (typeof SOURCES)[number];
  note: string;
};

export type Watchlist = {
  entries: WatchlistEntry[];
  /**
   * False when the file exists but could not be parsed. The entries are withheld and writes are
   * refused: saving what partially loaded would destroy the operator's list. Unreadable is not
   * empty — the distinction every state file in this tool is required to keep.
   */
  ok: boolean;
  error?: string;
};

/** What a caller stages for the list; timestamps and counts are the list's own business. */
export type WatchAddition = {
  kind: WatchlistEntry['kind'];
  id: string;
  source: WatchlistEntry['source'];
  note: string;
};

/** Identity key. JA4 digests are case-insensitive handles; IPs are kept as written. */
function keyOf(kind: string, id: string): string {
  return `${kind}:${kind === 'ja4' ? id.toLowerCase() : id}`;
}

/** The delimiter and line breaks cannot survive in a field of a line-based file. */
function cleanNote(note: string): string {
  return note
    .replace(/[|\r\n]+/g, ' ')
    .trim()
    .slice(0, NOTE_MAX);
}

/** Strict: one malformed line refuses the whole file, because a partial load that then saves is how hand edits get destroyed. `file` only names the culprit in errors — there are two now. */
export function parseWatchlist(raw: string, file: string): Watchlist {
  const entries: WatchlistEntry[] = [];
  for (const [i, text] of raw.split('\n').entries()) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const [kind, id, addedAt, lastSeen, seen, source, ...note] =
      trimmed.split('|');
    const bad = (why: string): Watchlist => ({
      entries: [],
      ok: false,
      error: `${file} line ${i + 1}: ${why}`,
    });
    if (!KINDS.includes(kind as WatchlistEntry['kind']))
      return bad(`kind must be ${KINDS.join(' or ')}`);
    if (!id) return bad('missing id');
    if (
      !addedAt ||
      !lastSeen ||
      Number.isNaN(Date.parse(addedAt)) ||
      Number.isNaN(Date.parse(lastSeen))
    )
      return bad('timestamps must be ISO dates');
    if (!Number.isInteger(Number(seen)) || Number(seen) < 1)
      return bad('seen must be a positive integer');
    if (!SOURCES.includes(source as WatchlistEntry['source']))
      return bad(`source must be ${SOURCES.join(' or ')}`);
    entries.push({
      kind: kind as WatchlistEntry['kind'],
      id: kind === 'ja4' ? id.toLowerCase() : id,
      addedAt,
      lastSeen,
      seen: Number(seen),
      source: source as WatchlistEntry['source'],
      note: note.join('|'),
    });
  }
  return { entries, ok: true };
}

/** Entries back to the on-disk shape. Ends with a newline so hand-appending a line is safe. */
export function formatWatchlist(entries: readonly WatchlistEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.kind}|${e.id}|${e.addedAt}|${e.lastSeen}|${e.seen}|${e.source}|${cleanNote(e.note)}\n`,
    )
    .join('');
}

/** Add or refresh one identity. Re-recording bumps seen/lastSeen and adopts the latest note; a manual mark outranks an automatic one and is never demoted back. */
export function upsertEntry(
  entries: readonly WatchlistEntry[],
  add: WatchAddition,
  at: Date,
): WatchlistEntry[] {
  const iso = at.toISOString();
  const key = keyOf(add.kind, add.id);
  const prior = entries.find((e) => keyOf(e.kind, e.id) === key);
  if (!prior)
    return [
      ...entries,
      {
        kind: add.kind,
        id: add.kind === 'ja4' ? add.id.toLowerCase() : add.id,
        addedAt: iso,
        lastSeen: iso,
        seen: 1,
        source: add.source,
        note: cleanNote(add.note),
      },
    ];
  return entries.map((e) =>
    e === prior
      ? {
          ...e,
          lastSeen: iso,
          seen: e.seen + 1,
          source: e.source === 'manual' ? 'manual' : add.source,
          note: cleanNote(add.note) || e.note,
        }
      : e,
  );
}

/** Drop one identity. */
export function removeEntry(
  entries: readonly WatchlistEntry[],
  kind: WatchlistEntry['kind'],
  id: string,
): WatchlistEntry[] {
  const key = keyOf(kind, id);
  return entries.filter((e) => keyOf(e.kind, e.id) !== key);
}

/** Load a list. A missing file is an empty list; anything else unreadable is UNKNOWN, ok:false. */
export async function readList(dir: string, file: string): Promise<Watchlist> {
  let raw: string;
  try {
    raw = await readFile(`${dir}/${file}`, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { entries: [], ok: true };
    return { entries: [], ok: false, error: errMsg(e) };
  }
  return parseWatchlist(raw, file);
}

// Two independent writers touch these files in ONE process: the operator's keystrokes and the
// watch tick's timer. Each does read-modify-write across an await, so a tick landing between a
// pane's read and its write drops whatever the other one did. Reading late narrows that window;
// it does not close it. Module-level, not per-caller, because a queue owned by the panes would
// leave the tick — the writer that actually races them — outside it.
let listWrites: Promise<unknown> = Promise.resolve();

/** Run a read-modify-write against the list files with the others held off until it finishes. */
export function withListLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chained off the settled result, so one caller's rejection cannot poison the queue.
  const next = listWrites.then(fn, fn);
  listWrites = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Persist a list. Returns an error message rather than throwing — the lists are a convenience and must never kill the loop that guards the site. */
export async function saveList(
  dir: string,
  file: string,
  entries: readonly WatchlistEntry[],
): Promise<string | undefined> {
  // Write-then-rename: a failure mid-write must never truncate the list it was replacing.
  const tmp = `${dir}/${file}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, formatWatchlist(entries), 'utf8');
    await rename(tmp, `${dir}/${file}`);
    return undefined;
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    return errMsg(e);
  }
}

/**
 * Read–upsert–write in one step, shared by the TUI tick and the CLI run.
 * Refuses to write over a file it could not read, and says so.
 */
export async function recordAdditions(
  dir: string,
  file: string,
  additions: readonly WatchAddition[],
  at: Date,
): Promise<{ entries?: WatchlistEntry[]; error?: string }> {
  if (!additions.length) return {};
  return withListLock(async () => {
    const list = await readList(dir, file);
    if (!list.ok)
      return { error: `${list.error ?? 'unreadable'} — nothing recorded` };
    let entries = list.entries;
    for (const add of additions) entries = upsertEntry(entries, add, at);
    const error = await saveList(dir, file, entries);
    return error ? { error } : { entries };
  });
}

/**
 * Record onto one list and drop the same identities from the other, so watch and ignore stay
 * exclusive by construction. Refuses when EITHER file is unreadable: dropping is half the move,
 * and doing only the addition would leave the identity on both lists with both meanings.
 */
export async function recordExclusive(
  dir: string,
  addFile: string,
  dropFile: string,
  additions: readonly WatchAddition[],
  at: Date,
): Promise<{
  added?: WatchlistEntry[];
  remaining?: WatchlistEntry[];
  error?: string;
}> {
  if (!additions.length) return {};
  return withListLock(async () => {
    const [target, other] = await Promise.all([
      readList(dir, addFile),
      readList(dir, dropFile),
    ]);
    if (!target.ok)
      return { error: `${target.error ?? 'unreadable'} — nothing recorded` };
    if (!other.ok)
      return { error: `${other.error ?? 'unreadable'} — nothing recorded` };
    let added = target.entries;
    for (const add of additions) added = upsertEntry(added, add, at);
    let remaining = other.entries;
    for (const add of additions)
      remaining = removeEntry(remaining, add.kind, add.id);
    // Add first: if the drop then fails, the identity sits on BOTH lists — confusing but nothing
    // is lost, and ignore keeps gating. Drop-first would risk losing it from both.
    const addError = await saveList(dir, addFile, added);
    if (addError) return { error: addError };
    if (remaining.length !== other.entries.length) {
      const dropError = await saveList(dir, dropFile, remaining);
      if (dropError)
        return {
          error: `half-moved — written to ${addFile} but ${dropFile} still lists it: ${dropError}`,
        };
    }
    return { added, remaining };
  });
}

/** Which list is being addressed. Watched and ignored are exclusive, so every operation names one. */
export type ListSide = 'watch' | 'ignore';

/** The file a side is stored in, and the one an identity moving there is dropped from. */
export function filesFor(to: ListSide): { add: string; drop: string } {
  return to === 'watch'
    ? { add: WATCHLIST_FILE, drop: IGNORELIST_FILE }
    : { add: IGNORELIST_FILE, drop: WATCHLIST_FILE };
}

// An unreadable list is UNKNOWN, not empty. Rendering it as empty says "nothing is being watched"
// about a file that could not be read, which is the reverse of what the operator needs to know.
/** The error a load should show, blank when it read cleanly. */
export function loadError(list: Watchlist): string {
  return list.ok ? '' : list.error || 'unreadable';
}

/** Cursor kept inside a list that has just changed length. Never negative — an empty list sits at 0. */
export function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length - 1));
}

/**
 * Where each list ends up after a move.
 *
 * `added` is always the destination and `remaining` always the source, so the two sides have to be
 * assigned by direction — swapping them silently writes the ignore list into the watch pane.
 */
export function afterMove(
  to: ListSide,
  added: WatchlistEntry[],
  remaining: WatchlistEntry[],
): { watch: WatchlistEntry[]; ignore: WatchlistEntry[] } {
  return to === 'watch'
    ? { watch: added, ignore: remaining }
    : { watch: remaining, ignore: added };
}

/** What to tell the operator after a move, naming the key that shows the list it landed on. */
export function moveNote(to: ListSide, id: string): string {
  return to === 'watch'
    ? `watching ${id} — t to view`
    : `ignoring ${id} — g to view · watch mode now skips it`;
}
