import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import {
  getCustomCursorEnabled,
  setCustomCursorEnabled,
  useCustomCursorEnabled,
} from '../hooks/useCustomCursorEnabled';
import { buildCanonical } from '../utils/canonical';
import { cycleTheme } from './ThemeToggle';

/**
 * In desktop (Electron) mode the native title bar owns the header's utility
 * buttons. This bridges the title bar's commands to the web app's existing
 * theme/cursor/share actions, and mirrors cursor state back for the icon.
 * Renders nothing and is a no-op in web mode (no `window.ssDesktop`).
 */
export default function DesktopBridge() {
  const router = useRouter();
  const cursorOn = useCustomCursorEnabled();

  useEffect(() => {
    const api = window.ssDesktop;
    if (!api) return; // web mode

    async function share() {
      const { pathname, search } = router.state.location;
      const url = buildCanonical(pathname, search as Record<string, string>);
      if (navigator.share) {
        try {
          await navigator.share({ title: document.title, url });
        } catch {
          /* share sheet cancelled */
        }
        return;
      }
      try {
        await navigator.clipboard?.writeText(url);
      } catch {
        /* clipboard unavailable */
      }
    }

    return api.onCommand((cmd) => {
      if (cmd === 'toggle-theme') cycleTheme();
      else if (cmd === 'toggle-cursor')
        setCustomCursorEnabled(!getCustomCursorEnabled());
      else if (cmd === 'share') void share();
    });
  }, [router]);

  // Mirror the custom-cursor on/off state to the native title-bar icon.
  useEffect(() => {
    window.ssDesktop?.reportCursor(cursorOn);
  }, [cursorOn]);

  return null;
}
