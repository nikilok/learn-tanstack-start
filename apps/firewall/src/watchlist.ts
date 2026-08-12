// The watch list — identities worth keeping an eye on, without denying anything. Fed
// automatically by watch mode (every profiled fingerprint) and manually from a profile tab.
//
// Tool-side state only: nothing here touches a WAF rule, so it does NOT live in .env.local.
// That file is written by deliberate operator action and fingerprinted around investigations to
// alarm on unattended writes; a background tick appending to it would either trip that alarm or
// normalise automation writing the secrets file. This sits with the loop's other state files.

import { readFile, writeFile } from 'node:fs/promises';

import { errMsg } from './util';

/** Repo root, gitignored. One entry per line: kind|id|addedAt|lastSeen|seen|source|note. */
export const WATCHLIST_FILE = '.firewall-watchlist';

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

/** Strict: one malformed line refuses the whole file, because a partial load that then saves is how hand edits get destroyed. */
export function parseWatchlist(raw: string): Watchlist {
  const entries: WatchlistEntry[] = [];
  for (const [i, text] of raw.split('\n').entries()) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const [kind, id, addedAt, lastSeen, seen, source, ...note] =
      trimmed.split('|');
    const bad = (why: string): Watchlist => ({
      entries: [],
      ok: false,
      error: `${WATCHLIST_FILE} line ${i + 1}: ${why}`,
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

/** Load the list. A missing file is an empty list; anything else unreadable is UNKNOWN, ok:false. */
export async function readWatchlist(dir: string): Promise<Watchlist> {
  let raw: string;
  try {
    raw = await readFile(`${dir}/${WATCHLIST_FILE}`, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { entries: [], ok: true };
    return { entries: [], ok: false, error: errMsg(e) };
  }
  return parseWatchlist(raw);
}

/** Persist the list. Returns an error message rather than throwing — the list is a convenience and must never kill the loop that guards the site. */
export async function saveWatchlist(
  dir: string,
  entries: readonly WatchlistEntry[],
): Promise<string | undefined> {
  try {
    await writeFile(
      `${dir}/${WATCHLIST_FILE}`,
      formatWatchlist(entries),
      'utf8',
    );
    return undefined;
  } catch (e) {
    return errMsg(e);
  }
}

/**
 * Read–upsert–write in one step, shared by the TUI tick, the CLI run and a manual mark.
 * Refuses to write over a file it could not read, and says so.
 */
export async function recordAdditions(
  dir: string,
  additions: readonly WatchAddition[],
  at: Date,
): Promise<{ entries?: WatchlistEntry[]; error?: string }> {
  if (!additions.length) return {};
  const list = await readWatchlist(dir);
  if (!list.ok)
    return { error: `${list.error ?? 'unreadable'} — nothing recorded` };
  let entries = list.entries;
  for (const add of additions) entries = upsertEntry(entries, add, at);
  const error = await saveWatchlist(dir, entries);
  return error ? { error } : { entries };
}
