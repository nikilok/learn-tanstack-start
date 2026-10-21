import { get } from '@vercel/global-config';

import { DEVICE_KEY_RE } from './key';

/** The Global Config item holding the device keys suspended from the company extras: a list of keys. */
export const SUSPENDED_KEYS_ITEM = 'suspendedDeviceKeys';

/**
 * The Global Config item holding the device keys refused a session: a list of keys, kept apart from
 * the extras' list (`SUSPENDED_KEYS_ITEM`). A key on it loses every session call, not the extras
 * alone, so it is a list of its own rather than the extras' list read again.
 */
export const SESSION_SUSPENDED_KEYS_ITEM = 'sessionSuspendedDeviceKeys';

/** Reads a list; undefined when no Global Config is connected (local runs, tests). */
export type ReadSuspended = () => Promise<unknown>;

/** A stored list, from Global Config when a store is connected. */
function storedList(item: string): ReadSuspended {
  return async () => {
    if (!process.env.GLOBAL_CONFIG && !process.env.EDGE_CONFIG)
      return undefined;
    return get(item);
  };
}

/** The extras' list. */
export const readSuspended: ReadSuspended = storedList(SUSPENDED_KEYS_ITEM);

/** The sessions' list. */
export const readSessionSuspended: ReadSuspended = storedList(
  SESSION_SUSPENDED_KEYS_ITEM,
);

/** The keys a stored value lists: none unless it is a list, and only its well-formed keys. */
export function suspendedKeysOf(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter(
      (key): key is string =>
        typeof key === 'string' && DEVICE_KEY_RE.test(key),
    ),
  );
}

/** How long a read list is reused before it is read again. */
const REREAD_MS = 60_000;

/** How long a read of the list may take before it counts as failed. */
export const READ_TIMEOUT_MS = 1000;

/** What `read` answers, or a failure once it has taken longer than `ms`. */
export async function readWithin<T>(
  read: () => Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a list at most once a minute, keeping the last good list when a read fails or takes longer
 * than `timeoutMs`; before any list has been read, a failed read suspends nobody, so a store that
 * is down, slow or misconfigured suspends nobody. Calls that find the list due while a read is out
 * share that read. Never throws.
 */
export function createSuspendedReader(
  read: ReadSuspended,
  rereadMs = REREAD_MS,
  timeoutMs = READ_TIMEOUT_MS,
) {
  let last: { at: number; keys: ReadonlySet<string> } | null = null;
  let reading: Promise<ReadonlySet<string>> | null = null;

  const readNow = async (now: number): Promise<ReadonlySet<string>> => {
    let keys: ReadonlySet<string>;
    try {
      keys = suspendedKeysOf(await readWithin(read, timeoutMs));
    } catch (error) {
      console.error(
        '[device] suspended device keys could not be read:',
        error instanceof Error ? error.message : error,
      );
      keys = last?.keys ?? new Set();
    }
    last = { at: now, keys };
    return keys;
  };

  return (now = Date.now()): Promise<ReadonlySet<string>> => {
    if (last && now - last.at < rereadMs) return Promise.resolve(last.keys);
    reading ??= readNow(now).finally(() => {
      reading = null;
    });
    return reading;
  };
}

/** The sessions' list, as the edge and the session endpoint read it. */
export const sessionSuspendedKeys = createSuspendedReader(readSessionSuspended);
