import { useEffect, useRef } from 'react';

import {
  matchesShortcut,
  type ShortcutId,
} from '../components/headerShortcuts';
import { isMacClient } from './useIsMac';

/**
 * Run `handler` when the header shortcut `id` is pressed. Each header control
 * registers its own, so the action stays with the button that owns it.
 *
 * Inert under `html[data-desktop]` — in the Electron shell the native title bar
 * matches these keys in the main process (and swallows them before the page sees
 * them), and in the /download preview iframe the embedded app must not steal them
 * from the real page. Both stamp the attribute pre-paint (`desktop-init.ts`).
 */
export function useShortcut(id: ShortcutId, handler: () => void): void {
  // Held in a ref so a changing handler never re-registers the listener.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (document.documentElement.dataset.desktop !== undefined) return;

    const isMac = isMacClient();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, id, isMac)) return;
      e.preventDefault();
      handlerRef.current();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [id]);
}
