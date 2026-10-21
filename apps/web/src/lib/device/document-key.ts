/** This document's device key, once asked for. */
let computed: Promise<string | null> | null = null;

/**
 * This document's device key, computed once on first use and shared by its pings (`beacons.ts`)
 * and its session ask (`session/client.ts`); null where it cannot be computed. Browser only.
 */
export function documentDeviceKey(): Promise<string | null> {
  computed ??= import('./setup')
    .then(({ computeDeviceKey }) => computeDeviceKey())
    // A failed import, or a computation that fails, is no key: it never rejects.
    .catch(() => null);
  return computed;
}
