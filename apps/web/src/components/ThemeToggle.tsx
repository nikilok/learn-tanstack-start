import { useEffect, useState } from 'react';

import { THEME_COLORS } from '../theme';
import { runThemeTransition } from '../theme-transition';
import { MonitorIcon, MoonIcon, SunIcon } from './ThemeIcons';

type ThemeMode = 'light' | 'dark' | 'auto';

/**
 * Read the persisted theme choice from `localStorage`. Returns `'auto'` on the
 * server (no `window`) and when the stored value is missing or unrecognized.
 */
function getInitialMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'auto';
  }

  const stored = window.localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark' || stored === 'auto') {
    return stored;
  }

  return 'auto';
}

/** Resolve a mode to a concrete `light`/`dark` theme, reading the OS preference for `'auto'`. */
function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;
}

/**
 * Apply a theme mode to the document: toggles the `light`/`dark` class and
 * `color-scheme` on `<html>`, and updates the `theme-color` meta so mobile
 * browser chrome matches the app background. `'auto'` resolves via
 * `prefers-color-scheme`. When `animate` is true and the resolved theme
 * actually changes, the swap is hidden inside a day<->night sky timelapse.
 */
function applyThemeMode(mode: ThemeMode, animate = false) {
  const resolved = resolveMode(mode);
  const root = document.documentElement;
  const current = root.classList.contains('dark') ? 'dark' : 'light';

  const swap = () => {
    root.classList.remove('light', 'dark');
    root.classList.add(resolved);
    root.style.colorScheme = resolved;

    // Update mobile browser chrome to match the app background
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (meta) {
      meta.content =
        resolved === 'dark' ? THEME_COLORS.dark : THEME_COLORS.light;
    }
  };

  if (animate && resolved !== current) {
    runThemeTransition(swap);
  } else {
    swap();
  }
}

/**
 * Three-state theme toggle button cycling light -> dark -> auto -> light.
 * Hydrates from `localStorage` after mount (the initial paint is handled by a
 * blocking `<head>` script so there's no flash), and subscribes to the OS
 * color-scheme media query only while in `'auto'` mode.
 */
export default function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>('auto');

  useEffect(() => {
    const initialMode = getInitialMode();
    setMode(initialMode);
    applyThemeMode(initialMode);
  }, []);

  useEffect(() => {
    if (mode !== 'auto') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeMode('auto', true);

    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [mode]);

  /**
   * Advance to the next mode in the light -> dark -> auto cycle, apply it to
   * the DOM, and persist the choice to `localStorage`.
   */
  function toggleMode() {
    const nextMode: ThemeMode =
      mode === 'light' ? 'dark' : mode === 'dark' ? 'auto' : 'light';
    setMode(nextMode);
    applyThemeMode(nextMode, true);
    window.localStorage.setItem('theme', nextMode);
  }

  const label =
    mode === 'auto'
      ? 'Theme mode: auto (system). Click to switch to light mode.'
      : `Theme mode: ${mode}. Click to switch mode.`;

  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={label}
      title={label}
      className="shadow-ring rounded-md p-2 text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink)"
    >
      {mode === 'light' && <SunIcon />}
      {mode === 'dark' && <MoonIcon />}
      {mode === 'auto' && <MonitorIcon />}
    </button>
  );
}
