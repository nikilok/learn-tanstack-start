// The payload shape every token-gated RPC validates the same way: a device
// key in the registry's form, and a token no longer than one could be.

import { DEVICE_KEY_RE } from './key';

/** Tokens are a fixed 54 characters; anything much longer is not one. */
export const TOKEN_MAX_LENGTH = 128;

/** The device key from an RPC payload, or a throw: a well-formed key is required by every token-gated fn. */
export function deviceKey(input: unknown): string {
  const key = (input as { key?: unknown } | null)?.key;
  if (typeof key !== 'string' || !DEVICE_KEY_RE.test(key)) {
    throw new Error('Invalid input');
  }
  return key;
}
