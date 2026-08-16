// Where recorded corpora live, and what is in the drawer.
//
// One cassette per scenario rather than one accumulating file: a recording appends, and on load
// later lines win per key, so a single shared cassette drifts toward whatever was recorded most
// recently. A scraper incident worth replaying next month has to be its own file.

import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { envText } from '../env';
import { readFwVars } from '../env-file';
import { REPO_ROOT } from '../repo-root';

/** Where corpora live inside the ops repo. Not a dotted name: it is tracked there, not hidden local state. */
export const CASSETTES_DIR = 'firewall-cassettes';

/** The private repo that holds them, as a sibling checkout of this one. */
export const OPS_REPO = 'sponsorsearch-ops';

const SUFFIX = '.jsonl';

/** What identifies the ops repo, whatever its directory is called. Renaming the checkout must not break the tool, and a name match alone would. */
const OPS_MARKER = join('firewall-operator', 'SKILL.md');

/** The env key holding the ops repo's absolute path, read from the repo-root `.env.local`. */
export const OPS_PATH_KEY = 'FW_OPS_PATH';

/** Whether `dir` actually is the ops repo, rather than merely existing. */
export function isOpsRepo(dir: string): boolean {
  return existsSync(join(dir, OPS_MARKER));
}

/** The configured ops-repo path, from the environment or the repo-root env file. Undefined when it is not configured at all — which is different from configured wrongly. */
export function configuredOpsPath(): string | undefined {
  // process.env first so an exported value still wins, then the file, which is what a
  // `--no-env-file` mock session cannot see any other way.
  const exported = envText(OPS_PATH_KEY);
  if (exported) return exported;
  // Read only when the environment did not answer — the previous shape computed this first and so
  // opened the file on every call, including the ones that never used it.
  //
  // `|| undefined`, not `?? undefined`: a blank assignment trims to '' and nullish coalescing
  // keeps it, which would hand a caller an empty path where envText gives undefined.
  return (
    readFwVars(join(REPO_ROOT, '.env.local'))[OPS_PATH_KEY]?.trim() || undefined
  );
}

/** The ops-repo checkout, found by its contents rather than its name. Used only when nothing is configured. */
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

/** Where corpora live, or why they cannot be reached. */
export type Drawer =
  | { kind: 'found'; dir: string; source: 'configured' | 'found' }
  | { kind: 'missing'; message: string };

/**
 * Resolve the cassette drawer.
 *
 * A recorded corpus is real client IPs, TLS fingerprints, UAs and paths — traffic data, which
 * belongs in the private repo and never in this one.
 *
 * `FW_OPS_PATH` in the repo-root `.env.local` is the answer when it is set, and a wrong value is
 * REFUSED rather than falling through to the search: a typo that silently resolves somewhere else
 * is how you record into one drawer and replay from another without noticing.
 */
export function resolveDrawer(): Drawer {
  return drawerFor(configuredOpsPath());
}

/** The decision itself, over an explicit configured value. Separate from resolveDrawer because a default parameter cannot express "nothing configured" — passing undefined re-triggers the default. */
export function drawerFor(configured: string | undefined): Drawer {
  if (configured) {
    const dir = resolve(configured);

    if (!existsSync(dir))
      return {
        kind: 'missing',
        message: `${OPS_PATH_KEY} points at ${dir}, which does not exist.`,
      };
    if (!isOpsRepo(dir))
      return {
        kind: 'missing',
        message: `${OPS_PATH_KEY} points at ${dir}, which does not hold ${OPS_MARKER} — that is not the ops repo.`,
      };
    return {
      kind: 'found',
      dir: join(dir, CASSETTES_DIR),
      source: 'configured',
    };
  }
  const ops = opsRepoDir();
  return ops
    ? { kind: 'found', dir: join(ops, CASSETTES_DIR), source: 'found' }
    : { kind: 'missing', message: NO_OPS_REPO };
}

/** The drawer path, or undefined when there is not one. */
export function cassettesDir(): string | undefined {
  const drawer = resolveDrawer();
  return drawer.kind === 'found' ? drawer.dir : undefined;
}

export const NO_OPS_REPO =
  `Cassettes live in the private ${OPS_REPO} repo, and it could not be found.\n` +
  `Looked for a directory holding ${OPS_MARKER} beside this repo.\n\n` +
  `Set its absolute path as ${OPS_PATH_KEY} in the repo-root .env.local:\n` +
  `  ${OPS_PATH_KEY}=/absolute/path/to/${OPS_REPO}`;

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

/**
 * Whole days between two instants, floored at zero.
 *
 * Floored because a filesystem mtime can read AHEAD of Date.now(), and Math.floor of a small
 * negative is -1 — a cassette written moments ago reported as "-1 days old". Callers pass whole
 * milliseconds on both sides: mtimeMs carries sub-millisecond precision and a Date does not, so
 * comparing them directly loses a day at the boundary.
 */
export function ageInDays(writtenMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - writtenMs) / (24 * 60 * 60 * 1000)));
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
  // A drawer that exists but cannot be read — wrong permissions, or removed between the check
  // above and here — is an empty drawer, not a crashed picker.
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of names) {
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
      ageDays: ageInDays(written, now.getTime()),
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
  // 0700 on creation only. The files inside are 0600, but a world-listable directory still hands
  // out the cassette NAMES, which an operator picks to describe an incident. An existing directory
  // is left alone: it is inside someone else's repo and its mode is their business.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
