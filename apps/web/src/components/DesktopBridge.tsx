import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import {
  getCustomCursorEnabled,
  setCustomCursorEnabled,
  useCustomCursorEnabled,
} from '../hooks/useCustomCursorEnabled';
import { buildCanonical } from '../utils/canonical';
import { cycleTheme, refreshTheme } from './ThemeToggle';

// Let the OS appearance repaint settle before the GPU transition, else they compete and it stutters.
const SYSTEM_FOLLOW_DELAY_MS = 250;

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

  // In `auto` mode the desktop follows OS appearance itself (the hidden web ThemeToggle is stale).
  useEffect(() => {
    if (!window.ssDesktop) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let timer = 0;
    const onChange = () => {
      const mode = window.localStorage.getItem('theme');
      if (mode === 'light' || mode === 'dark') return; // explicit mode: ignore OS
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        refreshTheme();
        window.ssDesktop?.pokeTheme();
      }, SYSTEM_FOLLOW_DELAY_MS);
    };
    media.addEventListener('change', onChange);
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener('change', onChange);
    };
  }, []);

  return null;
}
