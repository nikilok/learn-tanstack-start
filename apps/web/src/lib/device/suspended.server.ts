import { get } from '@vercel/global-config';

/** The Global Config item holding the suspended device keys: a list of keys. */
export const SUSPENDED_KEYS_ITEM = 'suspendedDeviceKeys';

/** Reads the list; undefined when no Global Config is connected (local runs, tests). */
export type ReadSuspended = () => Promise<unknown>;

const readSuspended: ReadSuspended = async () => {
  if (!process.env.GLOBAL_CONFIG && !process.env.EDGE_CONFIG) return undefined;
  return get(SUSPENDED_KEYS_ITEM);
};

/**
 * Whether a device key is suspended from the company extras: listed under
 * SUSPENDED_KEYS_ITEM. False whenever the list cannot be read (no store
 * connected, a failed read, a value that is not a list), so a store that is
 * down or misconfigured suspends nobody. Never throws.
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
  return Array.isArray(list) && list.includes(key);
}
