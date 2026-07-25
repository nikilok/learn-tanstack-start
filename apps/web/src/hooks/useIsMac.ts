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

/**
 * Whether the visitor is on macOS, resolved on the client only. The server
 * snapshot is always `false`: the header renders into edge-cached documents
 * (`/company/**`), so a UA-derived glyph baked into SSR HTML would be served to
 * the next visitor on another platform. Consumers must be able to take the
 * post-hydration flip — the keycaps can, being invisible until hover.
 */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribe, isMacClient, () => false);
}
