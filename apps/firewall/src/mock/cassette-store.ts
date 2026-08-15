// Where recorded corpora live, and what is in the drawer.
//
// One cassette per scenario rather than one accumulating file: a recording appends, and on load
// later lines win per key, so a single shared cassette drifts toward whatever was recorded most
// recently. A scraper incident worth replaying next month has to be its own file.

import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { envText } from '../env';
import { REPO_ROOT } from '../repo-root';

/** Where corpora live inside the ops repo. Not a dotted name: it is tracked there, not hidden local state. */
export const CASSETTES_DIR = 'firewall-cassettes';

/** The private repo that holds them, as a sibling checkout of this one. */
export const OPS_REPO = 'sponsorsearch-ops';

const SUFFIX = '.jsonl';

/** What identifies the ops repo, whatever its directory is called. Renaming the checkout must not break the tool, and a name match alone would. */
const OPS_MARKER = join('firewall-operator', 'SKILL.md');

/** The ops-repo checkout, found by its contents rather than its name. */
export function opsRepoDir(): string | undefined {
  const named = resolve(REPO_ROOT, '..', OPS_REPO);
  if (existsSync(join(named, OPS_MARKER))) return named;
  // Renamed, or cloned under another name. Its siblings are a handful of directories, and one
  // readdir at boot is cheaper than an operator wondering why the drawer is empty.
  const parent = resolve(REPO_ROOT, '..');
  let entries: string[];
  try {
    entries = readdirSync(parent).sort();
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = join(parent, entry);
    if (existsSync(join(candidate, OPS_MARKER))) return candidate;
  }
  return undefined;
}

/**
 * Where recorded corpora live, or undefined when the ops repo cannot be found.
 *
 * A recorded corpus is real client IPs, TLS fingerprints, UAs and paths — traffic data, which
 * belongs in the private repo and never in this one.
 *
 * FW_CASSETTES_DIR overrides, and must be EXPORTED rather than set in `.env.local`: a mock
 * session runs with `--no-env-file` to keep credentials out of the process, so a value living in
 * that file reaches a recording and not a replay — which would record into one drawer and read
 * from another, silently.
 */
export function cassettesDir(): string | undefined {
  const override = envText('FW_CASSETTES_DIR');
  if (override) return resolve(override);
  const ops = opsRepoDir();
  return ops ? join(ops, CASSETTES_DIR) : undefined;
}

export const NO_OPS_REPO =
  `Cassettes live in the private ${OPS_REPO} repo, and it could not be found.\n` +
  `Looked for a directory holding ${OPS_MARKER} beside this repo.\n\n` +
  'Clone it as a sibling, or export FW_CASSETTES_DIR pointing at its cassettes directory.\n' +
  'Export it in your shell — a value in .env.local reaches a recording but not a replay.';

// Interpolated into a path, so it is validated the way every other operator-supplied string in
// this tool is: an allow-list of what is legal, never a deny-list of what is not.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether `name` is safe to use as a file name. Rejects separators, traversal and leading dots outright. */
export function validCassetteName(name: string): boolean {
  return NAME.test(name) && !name.includes('..');
}

export const NAME_RULE =
  'a cassette name is 1-64 characters of letters, digits, dot, dash or underscore, starting with a letter or digit';

/** Absolute path for a cassette name, or undefined when the name is not one. */
export function cassettePathFor(
  name: string,
  dir: string | undefined = cassettesDir(),
): string | undefined {
  return dir && validCassetteName(name)
    ? join(dir, `${name}${SUFFIX}`)
    : undefined;
}

export type CassetteInfo = {
  name: string;
  path: string;
  bytes: number;
  /** Whole days since it was last written, for display. */
  ageDays: number;
  /** Exact write time, which is what the ordering uses — a whole-day figure cannot rank two recorded this morning. */
  writtenMs: number;
};

/** Every cassette in the drawer, newest first. A missing directory is an empty drawer, not an error. */
export function listCassettes(
  opts: { dir?: string; now?: Date } = {},
): CassetteInfo[] {
  const dir = opts.dir ?? cassettesDir();
  const now = opts.now ?? new Date();
  if (!dir || !existsSync(dir)) return [];
  const out: CassetteInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(SUFFIX)) continue;
    const name = entry.slice(0, -SUFFIX.length);
    // A file dropped in by hand can be named anything; only offer what could be recorded.
    if (!validCassetteName(name)) continue;
    const path = join(dir, entry);
    // lstat, NOT stat: it describes the entry itself rather than what it points at, so a symlink
    // and a dangling symlink both simply fail the isFile check below instead of being followed or
    // raising ENOENT. A cassette is a regular file — the write side refuses a link for the same
    // reason, so listing one we would then refuse to record into would be a lie.
    // The try/catch remains for the race: an entry removed between the readdir and the stat.
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    // A directory named `x.jsonl` reads as a cassette right up until loading it throws EISDIR.
    if (!stat.isFile()) continue;
    const written = Math.floor(stat.mtimeMs);
    out.push({
      name,
      path,
      bytes: stat.size,
      writtenMs: written,
      ageDays: Math.max(
        0,
        Math.floor((now.getTime() - written) / (24 * 60 * 60 * 1000)),
      ),
    });
  }
  // By the real write time, not the rounded day: everything recorded today has ageDays 0, so
  // sorting on that left the newest-first contract to whatever order readdir happened to return.
  return out.sort(
    (a, b) => b.writtenMs - a.writtenMs || a.name.localeCompare(b.name),
  );
}

/** Create the drawer so a recording has somewhere to land. Undefined when the ops repo is not there — never created, because that would mean inventing the private repo. */
export function prepareCassettesDir(
  dir: string | undefined = cassettesDir(),
): string | undefined {
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Human-readable size, so the picker can say how much traffic is behind a name. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long ago it was recorded, in the terms an operator judges a corpus by. */
export function ageLabel(ageDays: number): string {
  if (ageDays === 0) return 'today';
  if (ageDays === 1) return 'yesterday';
  return `${ageDays} days ago`;
}
