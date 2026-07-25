import { useSyncExternalStore } from 'react';

import { parsePlatform } from './usePlatform';

let cached: boolean | null = null;

/** The value never changes for a session, so nothing ever notifies. */
const subscribe = () => () => {};

/** Client-side macOS check, memoised so `useSyncExternalStore` sees a stable snapshot. */
export function isMacClient(): boolean {
  if (cached === null) {
    cached = parsePlatform(navigator.userAgent).platform === 'mac';
  }
  return cached;
}

/** The server snapshot: platform unknown, never a guess. */
const unknown = () => null;

/** macOS, or `null` pre-hydration. Client-only: the header lands in edge-cached `/company/**` docs, so SSR must not bake a UA-derived glyph. `null` not `false` — CSS hover reveals the chip before hydration. */
export function useIsMac(): boolean | null {
  return useSyncExternalStore(subscribe, isMacClient, unknown);
}
