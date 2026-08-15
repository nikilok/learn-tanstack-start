// The recorded corpus a mock session replays: how a query becomes a key, and how the file is read
// and appended.
//
// Recorded, never hand-written. This API behaves in ways nobody would guess — `limit` truncates
// below the cap, `botCategory` accepts a filter and matches zero rows, `botVerified` is 'pass' not
// 'true' — so a written fixture encodes what we BELIEVE and a recorded one encodes the API.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import type { Ctx, MetricsOpts } from '../observability';

export const RULE_NAMES_KEY = 'ruleNames';
export const LIVE_CONFIG_KEY = 'fetchLive';

/**
 * Bumped whenever a recorded key or value stops meaning what it used to.
 *
 * Without this a format change is SILENT: every lookup misses, and a cassette that answers nothing
 * is indistinguishable from a recording that never captured those panes. That is exactly what
 * happened when granularity moved ahead of span — a real 108 MB corpus went dead and looked like
 * an operator error.
 */
export const CASSETTE_VERSION = 1;

/** A cassette with no header at all: recorded before versioning, so nothing can be assumed about its keys. */
export const UNVERSIONED = 0;

type Header = { cassette: number };

/** The first line of a cassette, written when it is created. */
function headerLine(): string {
  return `${JSON.stringify({ cassette: CASSETTE_VERSION } satisfies Header)}\n`;
}

/** Read a line as a version header, or undefined when it is an ordinary entry. */
function versionOf(line: string): number | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<Header> & { k?: unknown };
    // `k` distinguishes it from an entry: an entry always has one, a header never does.
    return parsed.k === undefined && typeof parsed.cassette === 'number'
      ? parsed.cassette
      : undefined;
  } catch {
    return undefined;
  }
}

/** The two keys one metrics query answers to. */
export type Keys = {
  /** Everything that shaped the query, window included. */
  exact: string;
  /** The same query with the window dropped, so a cassette still answers after the operator changes range. */
  loose: string;
};

/** Both lookup keys for one metrics query. Absolute timestamps are deliberately absent: the window's SHAPE is what makes two queries comparable, and a recording made an hour ago would otherwise miss every time. */
export function metricsKeys(
  ctx: Ctx,
  groupBy: string[],
  opts: MetricsOpts,
): Keys {
  // A JSON array, not delimiter-joined text. The filter is the one free-form field and it carries
  // request paths, which are ultimately client-supplied — so it can hold whatever separator the
  // key uses. No collision was reachable with the old format (the limit is numeric and terminal,
  // which made it unambiguous), but that is an accident of the field order rather than a property
  // of the encoding, and the next field appended after `limit` would end it.
  const parts: unknown[] = [
    opts.event ?? 'incomingRequest',
    [...groupBy],
    opts.filter ?? '',
    opts.limit ?? 500,
  ];
  const start = Date.parse(opts.startTime ?? ctx.startTime);
  const end = Date.parse(opts.endTime ?? ctx.endTime);
  const span =
    Number.isFinite(start) && Number.isFinite(end)
      ? Math.round((end - start) / 60_000)
      : 0;
  // Granularity is in the LOOSE key, not just the exact one. It is the bucket size, so a
  // 10-minute-bucket query answered from an hourly recording gets a series whose points mean
  // something else — and the session shape and duty cycle are computed straight off it. Dropping
  // only the span still lets 1h/3h/6h/24h/6d substitute for each other, which is the whole point
  // of the fallback; it is the live window, the one that buckets differently, that is excluded.
  const shape = [...parts, canonical(opts.granularity ?? ctx.granularity)];
  return {
    loose: `metrics${JSON.stringify(shape)}`,
    exact: `metrics${JSON.stringify([...shape, span])}`,
  };
}

/** Key-value pairs in a fixed order, so two equivalent objects serialise identically whatever order they were built in. */
function canonical(value: Record<string, number>): [string, number][] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

/** Whole days since the cassette was last written, or undefined when there is none. Traffic shapes drift, and a corpus read as current when it is months old is misleading in the same direction every time. */
export function cassetteAgeDays(
  path: string,
  now: Date = new Date(),
): number | undefined {
  if (!existsSync(path)) return undefined;
  // Whole milliseconds on both sides: mtimeMs carries sub-millisecond precision and a Date does
  // not, so comparing them directly loses a day at the boundary.
  const written = Math.floor(statSync(path).mtimeMs);
  // Floored at zero: a filesystem mtime can read AHEAD of Date.now(), and Math.floor of a small
  // negative is -1 — a cassette written moments ago reported as "-1 days old".
  return Math.max(
    0,
    Math.floor((now.getTime() - written) / (24 * 60 * 60 * 1000)),
  );
}

export type Cassette = Map<string, unknown>;

export type LoadedCassette = {
  /** The format the file declares, or UNVERSIONED when it predates the header. */
  version: number;
  /** Keyed by the exact query. */
  entries: Cassette;
  /** The same recordings keyed by their window-independent key, for the fallback lookup. */
  loose: Cassette;
  /** Lines that would not parse. Reported rather than thrown: a truncated last line is what a crash mid-record leaves behind, and the rest of the corpus is still good. */
  skipped: number;
};

/** Read the cassette. Later lines win, so re-recording a query supersedes the earlier answer. A missing file is an empty corpus, not an error. */
export function loadCassette(path: string): LoadedCassette {
  const entries: Cassette = new Map();
  const loose: Cassette = new Map();
  if (!existsSync(path))
    return { version: CASSETTE_VERSION, entries, loose, skipped: 0 };
  let skipped = 0;
  let version = UNVERSIONED;
  let first = true;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (first) {
      first = false;
      const declared = versionOf(line);
      if (declared !== undefined) {
        version = declared;
        continue;
      }
    }
    try {
      const row = JSON.parse(line) as { k?: unknown; l?: unknown; v?: unknown };
      // The value is checked as well as the key. Storing a row with no value put the key in the
      // map with `undefined` behind it, so `has()` said yes, the replay returned undefined, and
      // the first reader to touch `.summary` threw — a truncated line taking out a pane.
      if (typeof row.k !== 'string' || row.v === undefined || row.v === null) {
        skipped++;
        continue;
      }
      entries.set(row.k, row.v);
      // Stored rather than derived from the exact key: a filter is interpolated user data and
      // splitting the key back apart on a separator it could contain is how that goes wrong.
      if (typeof row.l === 'string') loose.set(row.l, row.v);
    } catch {
      skipped++;
    }
  }
  return { version, entries, loose, skipped };
}

/**
 * Make sure the cassette exists and only its owner can read it, once, before a recording starts.
 *
 * `appendCassette`'s create-mode covers a file this tool made. It does NOT cover one that arrived
 * some other way — and copying a corpus in from the ops repo is a documented workflow, which
 * brings 0644 with it. Done here rather than per append so a recording pays one syscall, not one
 * per query.
 */
export function ensureOwnerOnly(path: string): void {
  // A symlink is refused rather than followed. chmod and append both act on the TARGET, so a link
  // planted at the cassette path would have this tool change the permissions of, and write JSON
  // into, a file somewhere else entirely. Listing skips links for the same reason.
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error(
      `${path} is a symlink, and a cassette must be a regular file — writing through it would rewrite whatever it points at`,
    );
  if (!existsSync(path)) writeFileSync(path, headerLine(), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Append one recorded response. Synchronous, so concurrent queries serialise on the event loop instead of interleaving half-written lines. */
export function appendCassette(
  path: string,
  key: string,
  value: unknown,
  loose?: string,
): void {
  const row = loose ? { k: key, l: loose, v: value } : { k: key, v: value };
  // 0600 on creation: the corpus is real client IPs and TLS fingerprints, and the default 0644
  // makes it readable by every account on the machine. umask cannot widen it — it only clears
  // bits, and there are no group or other bits here to clear.
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
