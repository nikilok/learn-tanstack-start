/**
 * When each hosting address is next free. Kept in a file every walk on this
 * machine shares, so slices run side by side take turns at an address rather
 * than each pacing alone.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
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

/** A ledger one process keeps to itself. */
export function memoryLedger(): Ledger {
  let turns: Turns = {};
  return {
    reserve(addresses, gapMs, now) {
      const taken = takeTurn(turns, addresses, gapMs, now);
      turns = taken.turns;
      return taken.turn;
    },
  };
}

/** How long a lock may be held before it counts as left behind. */
const STALE_LOCK_MS = 2_000;
/** How long to wait for the lock before pacing alone. */
const LOCK_WAIT_MS = 5_000;

export type FileLedgerOptions = {
  /** Told once, when the file cannot be used and this process paces alone. */
  warn?: (message: string) => void;
  staleLockMs?: number;
  lockWaitMs?: number;
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

/** Take the lock, waiting out another process's hold on it; one left behind by a process that died is cleared. */
function acquire(lock: string, staleMs: number, waitMs: number): void {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
    try {
      // Two processes clearing one stale lock can both get in once: a turn given twice, nothing worse.
      if (Date.now() - statSync(lock).mtimeMs > staleMs) rmdirSync(lock);
    } catch {
      // Released meanwhile.
    }
    if (Date.now() >= deadline) {
      throw Object.assign(new Error('ledger lock is held'), {
        code: 'ELOCKED',
      });
    }
    Bun.sleepSync(1);
  }
}

/** Give the lock back; one another process cleared as stale is already gone. */
function release(lock: string): void {
  try {
    rmdirSync(lock);
  } catch {
    // Cleared by another process.
  }
}

/** The turns on file; none when it is missing or will not parse. */
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

/** A ledger in `dir`, shared by every process of this user that opens it; one that cannot use its file, or whose directory is not this user's alone, paces this process alone and says so once. */
export function fileLedger(
  dir: string,
  options: FileLedgerOptions = {},
): Ledger {
  const lock = join(dir, 'lock');
  const file = join(dir, 'turns.json');
  const staleMs = options.staleLockMs ?? STALE_LOCK_MS;
  const waitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  let made = false;
  let alone: Ledger | null = null;
  return {
    reserve(addresses, gapMs, now) {
      if (alone) return alone.reserve(addresses, gapMs, now);
      try {
        if (!made) {
          claim(dir);
          made = true;
        }
        acquire(lock, staleMs, waitMs);
        try {
          const taken = takeTurn(read(file), addresses, gapMs, now);
          writeFileSync(file, JSON.stringify(taken.turns), { mode: 0o600 });
          return taken.turn;
        } finally {
          release(lock);
        }
      } catch (error) {
        // Reason only: a path would name the machine's user.
        options.warn?.(
          `  address ledger unavailable (${codeOf(error)}): this process paces alone`,
        );
        alone = memoryLedger();
        return alone.reserve(addresses, gapMs, now);
      }
    },
  };
}
