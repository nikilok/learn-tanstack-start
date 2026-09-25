import { DEVICE_KEY_RE } from './key';

/** Whether this document can load the company extras yet. `ready` and `off` are both final. */
export type Readiness =
  | { status: 'waiting' }
  | { status: 'off' }
  | { status: 'ready'; key: string };

/** Initial snapshot, and the server's: nothing ready before hydration. */
export const WAITING: Readiness = { status: 'waiting' };

const OFF: Readiness = { status: 'off' };

/**
 * Ready once a well-formed device key has arrived and the visitor has engaged,
 * in either order; `off` when neither can happen in this document. Snapshots
 * stay referentially stable between changes, as useSyncExternalStore requires.
 */
export function createReadiness() {
  let key: string | null = null;
  let engaged = false;
  let snapshot: Readiness = WAITING;
  const listeners = new Set<() => void>();

  const settle = (next: Readiness) => {
    if (snapshot.status !== 'waiting') return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const check = () => {
    if (key !== null && engaged) settle({ status: 'ready', key });
  };

  return {
    key(candidate: string) {
      if (key !== null || !DEVICE_KEY_RE.test(candidate)) return;
      key = candidate;
      check();
    },
    engage() {
      engaged = true;
      check();
    },
    off() {
      settle(OFF);
    },
    snapshot: (): Readiness => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
