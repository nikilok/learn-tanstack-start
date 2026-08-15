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

/**
 * The ops-repo checkout, or undefined when there is not one to find.
 *
 * A recorded corpus is real client IPs, TLS fingerprints, UAs and paths — traffic data, which
 * belongs in the private repo and never in this one. FW_CASSETTES_DIR overrides for a checkout
 * that is not a sibling; there are two of them.
 */
export function cassettesDir(): string | undefined {
  const override = envText('FW_CASSETTES_DIR');
  if (override) return resolve(override);
  const ops = resolve(REPO_ROOT, '..', OPS_REPO);
  return existsSync(ops) ? join(ops, CASSETTES_DIR) : undefined;
}

export const NO_OPS_REPO =
  `Cassettes live in the private ${OPS_REPO} repo, and it is not checked out beside this one.\n` +
  `Clone it as a sibling of this repo, or point FW_CASSETTES_DIR at where it is.`;

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
