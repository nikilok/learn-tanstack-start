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
// Single-writer by assumption. A TUI tick and a CLI run racing the same file can lose one
// seen-bump to a read-modify-write overlap — tolerated: saves go through a write-then-rename,
// so a race can drop a count, never leave a file half-written.

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
  const list = await readList(dir, file);
  if (!list.ok)
    return { error: `${list.error ?? 'unreadable'} — nothing recorded` };
  let entries = list.entries;
  for (const add of additions) entries = upsertEntry(entries, add, at);
  const error = await saveList(dir, file, entries);
  return error ? { error } : { entries };
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
}
