import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'custom-cursor';
const subscribers = new Set<() => void>();

/** Read the persisted on/off choice; defaults to enabled when unset or unreadable. */
function readStorage(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** SSR/hydration default — on, matching the previously-hardcoded cursor. */
function getServerSnapshot(): boolean {
  return true;
}

/** Register a subscriber notified on in-tab preference changes. */
function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** Persist the custom-cursor on/off choice and re-render subscribers in this tab. */
export function setCustomCursorEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // storage may be unavailable (private mode); the in-tab toggle still works
  }
  for (const notify of subscribers) {
    notify();
  }
}

/** Reactively read whether the custom cursor is enabled (persisted, defaults to on). */
export function useCustomCursorEnabled(): boolean {
  return useSyncExternalStore(subscribe, readStorage, getServerSnapshot);
}

/** Imperative read of the persisted on/off choice (for the desktop command bridge). */
export function getCustomCursorEnabled(): boolean {
  return readStorage();
}
