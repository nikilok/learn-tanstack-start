import {
  type ReadSuspended,
  readSuspended,
  suspendedKeysOf,
} from './suspended';

/**
 * Whether a device key is suspended from the company extras: listed under SUSPENDED_KEYS_ITEM
 * (`suspended.ts`). False whenever the list cannot be read (no store connected, a failed read, a
 * value that is not a list), so a store that is down or misconfigured suspends nobody. Read afresh
 * on every call. Never throws.
 */
export async function isSuspended(
  key: string,
  read: ReadSuspended = readSuspended,
): Promise<boolean> {
  let list: unknown;
  try {
    list = await read();
  } catch (error) {
    console.error(
      '[extras] suspended device keys could not be read:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
  return suspendedKeysOf(list).has(key);
}
