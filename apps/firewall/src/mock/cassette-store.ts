// Where recorded corpora live, and what is in the drawer.
//
// One cassette per scenario rather than one accumulating file: a recording appends, and on load
// later lines win per key, so a single shared cassette drifts toward whatever was recorded most
// recently. A scraper incident worth replaying next month has to be its own file.

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../repo-root';

export const CASSETTES_DIR = '.firewall-cassettes';
const SUFFIX = '.jsonl';

/** The directory holding every recorded corpus. */
export function cassettesDir(): string {
  return join(REPO_ROOT, CASSETTES_DIR);
}

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
  dir: string = cassettesDir(),
): string | undefined {
  return validCassetteName(name) ? join(dir, `${name}${SUFFIX}`) : undefined;
}

export type CassetteInfo = {
  name: string;
  path: string;
  bytes: number;
  /** Whole days since it was last written. */
  ageDays: number;
};

/** Every cassette in the drawer, newest first. A missing directory is an empty drawer, not an error. */
export function listCassettes(
  opts: { dir?: string; now?: Date } = {},
): CassetteInfo[] {
  const dir = opts.dir ?? cassettesDir();
  const now = opts.now ?? new Date();
  if (!existsSync(dir)) return [];
  const out: CassetteInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(SUFFIX)) continue;
    const name = entry.slice(0, -SUFFIX.length);
    // A file dropped in by hand can be named anything; only offer what could be recorded.
    if (!validCassetteName(name)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    // A directory named `x.jsonl` reads as a cassette right up until loading it throws EISDIR and
    // takes the boot down. statSync follows symlinks, so a link to a real file still counts.
    if (!stat.isFile()) continue;
    const written = Math.floor(stat.mtimeMs);
    out.push({
      name,
      path,
      bytes: stat.size,
      ageDays: Math.max(
        0,
        Math.floor((now.getTime() - written) / (24 * 60 * 60 * 1000)),
      ),
    });
  }
  return out.sort(
    (a, b) => a.ageDays - b.ageDays || a.name.localeCompare(b.name),
  );
}

/** Create the drawer so a recording has somewhere to land. */
export function prepareCassettesDir(dir: string = cassettesDir()): string {
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
