/**
 * When each hosting address is next free. Kept in files every walk on this
 * machine shares, so slices run side by side take turns at an address rather
 * than each pacing alone. Every change is a new numbered file, and only one
 * process can make the next number, so there is no lock to be left behind or
 * taken from a process that is only slow.
 */

import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Each address and when it is next free, in epoch milliseconds. */
export type Turns = Record<string, number>;

export type Ledger = {
  /** Take the next turn at these addresses, at least `gapMs` after the last one taken at any of them; returns when it starts. */
  reserve(addresses: readonly string[], gapMs: number, now: number): number;
};

/** The turn a request to these addresses gets, and the turns once it is taken; ones already past are dropped. */
export function takeTurn(
  turns: Readonly<Turns>,
  addresses: readonly string[],
  gapMs: number,
  now: number,
): { turn: number; turns: Turns } {
  let turn = now;
  for (const address of addresses) turn = Math.max(turn, turns[address] ?? 0);
  const next: Turns = {};
  for (const [address, free] of Object.entries(turns)) {
    if (free > now) next[address] = free;
  }
  for (const address of addresses) next[address] = turn + gapMs;
  return { turn, turns: next };
}

/** A ledger one process keeps to itself, starting from the turns it is given. */
export function memoryLedger(known: Readonly<Turns> = {}): Ledger {
  let turns: Turns = { ...known };
  return {
    reserve(addresses, gapMs, now) {
      const taken = takeTurn(turns, addresses, gapMs, now);
      turns = taken.turns;
      return taken.turn;
    },
  };
}

/** Times in a row a process may lose the race for the next number before it paces alone. */
const MAX_ATTEMPTS = 200;

/** Numbered files kept behind the newest. A number is only ever free again once it is this far behind, which tells a process that fell behind from one others have since built on. */
export const KEPT = 64;

export type FileLedgerOptions = {
  /** Told once, when the files cannot be used and this process paces alone. */
  warn?: (message: string) => void;
  /** Called once the turns are read, and once the next file is made: how a test lets another process in between. */
  between?: (stage: 'read' | 'made') => void;
  maxAttempts?: number;
};

/** Where this user's walks keep the ledger they share. */
export function sharedLedgerDir(): string {
  return join(tmpdir(), `sponsorsearch-walk-${process.getuid?.() ?? 0}`);
}

/** The error code of a failed file call, or its name. */
function codeOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  return (error as NodeJS.ErrnoException).code ?? error.name;
}

/** Make the ledger's directory, or refuse one that is not this user's alone: whoever can write there can write the turns. */
function claim(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const found = lstatSync(dir);
  const mine = found.uid === process.getuid?.();
  // A link in its place, another user's directory, or one others may write to.
  if (!found.isDirectory() || !mine || (found.mode & 0o022) !== 0) {
    throw Object.assign(new Error('ledger directory is not ours alone'), {
      code: 'EUNTRUSTED',
    });
  }
}

/** The path of the turns file with this number. */
function numbered(dir: string, number: number): string {
  return join(dir, `turns.${number}.json`);
}

/** The numbers of the turns files in the directory. */
function numbers(dir: string): number[] {
  return readdirSync(dir).flatMap((name) => {
    const match = /^turns\.(\d{1,15})\.json$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
}

/** Remove a file that may already be gone. */
function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Tidied by another process.
  }
}

/** The turns in a file; none when it is missing or will not parse. */
function read(file: string): Turns {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const turns: Turns = {};
    for (const [address, free] of Object.entries(parsed)) {
      if (typeof free === 'number' && Number.isFinite(free)) {
        turns[address] = free;
      }
    }
    return turns;
  } catch {
    return {};
  }
}

/** The newest turns in a ledger directory. */
export function currentTurns(dir: string): Turns {
  const newest = Math.max(0, ...numbers(dir));
  return newest === 0 ? {} : read(numbered(dir, newest));
}

let drafts = 0;

/** Publish these turns as the file with this number, which only one process can do; false when another got there first, or when the number is so far behind the newest that it may only have been free because its file was tidied away. A false is never a shared turn: the caller reads again and takes another. */
function publish(
  dir: string,
  number: number,
  turns: Turns,
  made?: () => void,
): boolean {
  const draft = join(dir, `draft.${process.pid}.${drafts++}`);
  writeFileSync(draft, JSON.stringify(turns), { mode: 0o600 });
  try {
    // A link never replaces a file, so the next number goes to whoever makes it first.
    linkSync(draft, numbered(dir, number));
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
    return false;
  } finally {
    remove(draft);
  }
  made?.();
  const present = numbers(dir);
  // KEPT or more behind the newest: it cannot be told from a number freed by tidying, so it is not trusted.
  if (Math.max(...present) - number >= KEPT) return false;
  for (const older of present) {
    if (older <= number - KEPT) remove(numbered(dir, older));
  }
  return true;
}

/** A ledger in `dir`, shared by every process of this user that opens it; one that cannot use its files, or whose directory is not this user's alone, paces this process alone from the turns it last knew, and says so once. */
export function fileLedger(
  dir: string,
  options: FileLedgerOptions = {},
): Ledger {
  const attempts = options.maxAttempts ?? MAX_ATTEMPTS;
  let claimed = false;
  let known: Turns = {};
  let alone: Ledger | null = null;
  return {
    reserve(addresses, gapMs, now) {
      if (alone) return alone.reserve(addresses, gapMs, now);
      try {
        if (!claimed) {
          claim(dir);
          claimed = true;
        }
        for (let attempt = 0; attempt < attempts; attempt++) {
          const newest = Math.max(0, ...numbers(dir));
          known = newest === 0 ? {} : read(numbered(dir, newest));
          const taken = takeTurn(known, addresses, gapMs, now);
          options.between?.('read');
          const made = () => options.between?.('made');
          if (publish(dir, newest + 1, taken.turns, made)) {
            known = taken.turns;
            return taken.turn;
          }
        }
        // Beaten every time: what beat it last is the most this process can know.
        known = currentTurns(dir);
        throw Object.assign(new Error('ledger is contended'), {
          code: 'ECONTENDED',
        });
      } catch (error) {
        // Reason only: a path would name the machine's user.
        options.warn?.(
          `  address ledger unavailable (${codeOf(error)}): this process paces alone`,
        );
        alone = memoryLedger(known);
        return alone.reserve(addresses, gapMs, now);
      }
    },
  };
}
