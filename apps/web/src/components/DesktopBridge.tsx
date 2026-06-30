import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import {
  getCustomCursorEnabled,
  setCustomCursorEnabled,
  useCustomCursorEnabled,
} from '../hooks/useCustomCursorEnabled';
import { buildCanonical } from '../utils/canonical';
import { cycleTheme, refreshTheme } from './ThemeToggle';

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

    // The click happens in the title-bar document, so there's no user gesture here —
    // copy via the main-process clipboard (the web app's canonical URL).
    function share() {
      const { pathname, search } = router.state.location;
      window.ssDesktop?.copy(
        buildCanonical(pathname, search as Record<string, string>),
      );
    }

    return api.onCommand((cmd) => {
      if (cmd === 'toggle-theme') {
        cycleTheme();
        window.ssDesktop?.pokeTheme(); // re-report mode even if the resolved theme is unchanged
      } else if (cmd === 'toggle-cursor') {
        setCustomCursorEnabled(!getCustomCursorEnabled());
      } else if (cmd === 'share') {
        share();
      }
    });
  }, [router]);

  // Mirror the custom-cursor on/off state to the native title-bar icon.
  useEffect(() => {
    window.ssDesktop?.reportCursor(cursorOn);
  }, [cursorOn]);

  // In `auto` mode the desktop must follow OS appearance changes itself — the hidden
  // web ThemeToggle's listener is unreliable once the mode was set from the title bar.
  useEffect(() => {
    if (!window.ssDesktop) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const mode = window.localStorage.getItem('theme');
      if (mode !== 'light' && mode !== 'dark') {
        refreshTheme();
        window.ssDesktop?.pokeTheme();
      }
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return null;
}
