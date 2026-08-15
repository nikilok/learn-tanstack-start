// The recorded corpus a mock session replays: how a query becomes a key, and how the file is read
// and appended.
//
// Recorded, never hand-written. This API behaves in ways nobody would guess — `limit` truncates
// below the cap, `botCategory` accepts a filter and matches zero rows, `botVerified` is 'pass' not
// 'true' — so a written fixture encodes what we BELIEVE and a recorded one encodes the API.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

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
 *
 * History, newest first:
 *   2 — values gzipped and base64'd
 *   1 — the first versioned format; keys already carried granularity ahead of span
 *   0 — UNVERSIONED, no header at all, key layout unknown
 *
 * The key layout has NOT changed since versioning began: granularity moved ahead of span in the
 * commit before the header existed, which is what made that corpus die silently and prompted this.
 */
export const CASSETTE_VERSION = 2;

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

/**
 * A recorded value on disk: gzipped JSON, base64'd so it still fits one JSONL line.
 *
 * A corpus is mostly per-bucket `data` arrays — measured at 112.8 MB against 0.7 MB of `summary`
 * on a real recording — which compresses about 28x. That is the difference between a cassette
 * that can be committed to the ops repo and one that exceeds GitHub's file limit outright.
 * The KEY stays plaintext, so the file is still greppable by query.
 */
function packValue(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value))).toString('base64');
}

/** Undefined when the row cannot be unpacked, which the caller counts as skipped rather than storing. */
function unpackValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(gunzipSync(Buffer.from(raw, 'base64')).toString());
  } catch {
    return undefined;
  }
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
      // The value is checked as well as the key, and unpacked before either map sees it. Storing
      // a row with no value put the key in the map with `undefined` behind it, so `has()` said
      // yes, the replay returned undefined, and the first reader to touch `.summary` threw.
      const value = unpackValue(row.v);
      if (typeof row.k !== 'string' || value === undefined || value === null) {
        skipped++;
        continue;
      }
      entries.set(row.k, value);
      // Stored rather than derived from the exact key: a filter is interpolated user data and
      // splitting the key back apart on a separator it could contain is how that goes wrong.
      if (typeof row.l === 'string') loose.set(row.l, value);
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
  ensureOwnerOnlyFile(path, headerLine(), 'cassette');
}

/** The format an existing cassette declares, without reading the rest of it. A stale corpus can be 100 MB, and it is about to be discarded. */
export function headerVersionOf(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString();
    const end = text.indexOf('\n');
    return versionOf(end === -1 ? text : text.slice(0, end)) ?? UNVERSIONED;
  } finally {
    closeSync(fd);
  }
}

/**
 * Truncate a cassette back to a bare header of the CURRENT format.
 *
 * A recording appends, so re-recording into a cassette this build cannot read left the old header
 * in place and buried fresh entries under it — the file stayed refused, and the refusal's own
 * advice ("re-record it") led nowhere. Destructive on purpose: the old content is unreadable by
 * definition, and re-recording is how an operator asks for it to be replaced.
 */
export function resetCassette(path: string): void {
  writeFileSync(path, headerLine(), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Create `path` owner-only with `initial` if it is not there, and tighten it if it is.
 *
 * Shared with the miss log, which carries the same material: a miss line records the QUERY, and a
 * query's filter names the client IP or fingerprint it was about.
 */
export function ensureOwnerOnlyFile(
  path: string,
  initial: string,
  what = 'file',
): void {
  try {
    // 'wx' both creates atomically and tells us the path was already there — including when it is
    // a symlink, which it refuses to create through. One check, after this, therefore covers a
    // link that was already present AND one planted a moment ago; a check before it was redundant.
    writeFileSync(path, initial, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // chmod follows a link and would change the TARGET's permissions, so ask what this really is
    // before touching it. One lstat, and anything that is not a REGULAR file is refused: a
    // directory here also survives 'wx' as EEXIST, and would be chmod'd and then appended to,
    // failing later as EISDIR instead of here. Listing skips both for the same reason.
    const stat = lstatSync(path);
    if (!stat.isFile())
      throw new Error(
        `${path} is ${
          stat.isSymbolicLink() ? 'a symlink' : 'not a regular file'
        }, and a ${what} must be one — writing through it would rewrite something else`,
      );
  }
  chmodSync(path, 0o600);
}

/** Append one recorded response. Synchronous, so concurrent queries serialise on the event loop instead of interleaving half-written lines. */
export function appendCassette(
  path: string,
  key: string,
  value: unknown,
  loose?: string,
): void {
  const packed = packValue(value);
  const row = loose ? { k: key, l: loose, v: packed } : { k: key, v: packed };
  // 0600 on creation: the corpus is real client IPs and TLS fingerprints, and the default 0644
  // makes it readable by every account on the machine. umask cannot widen it — it only clears
  // bits, and there are no group or other bits here to clear.
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
