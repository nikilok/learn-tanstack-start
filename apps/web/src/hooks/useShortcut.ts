import { useEffect, useRef } from 'react';

import {
  matchesShortcut,
  type ShortcutId,
} from '../components/headerShortcuts';
import { isMacClient } from './useIsMac';

/** True when the Electron shell or the /download preview owns these keys (stamped pre-paint by desktop-init). */
export function shellOwnsShortcuts(root: { dataset: DOMStringMap }): boolean {
  return root.dataset.desktop !== undefined;
}

/** Run `handler` on shortcut `id` — each control registers its own. Inert under `data-desktop`: the shell matches these in its main process. */
export function useShortcut(id: ShortcutId, handler: () => void): void {
  // Held in a ref so a changing handler never re-registers the listener.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (shellOwnsShortcuts(document.documentElement)) return;

    const isMac = isMacClient();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, id, isMac)) return;
      // Cancel repeats too, else a held combo hands them to the browser's own binding.
      e.preventDefault();
      if (e.repeat) return;
      handlerRef.current();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [id]);
}
