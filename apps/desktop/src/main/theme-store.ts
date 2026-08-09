import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { parseThemeMode } from './theme-mode';
import type { ThemeMode } from './theme-mode';

/**
 * The one thing the shell has to remember between launches: which theme the user is on.
 *
 * The choice itself lives in the site's localStorage, which the splash cannot read — it is
 * a file:// document on a different origin, and it has to paint before the page has loaded
 * to tell anyone anything. So the shell keeps its own copy of what the page last reported
 * and starts the next launch on it.
 */
const FILE = 'shell-state.json';

let lastSaved: ThemeMode | null = null;

/** The theme the page last reported, or null before it has ever reported one. */
export function readSavedThemeMode(): ThemeMode | null {
  try {
    const raw = readFileSync(join(app.getPath('userData'), FILE), 'utf8');
    const mode = parseThemeMode(
      (JSON.parse(raw) as { themeMode?: unknown }).themeMode,
    );
    lastSaved = mode;
    return mode;
  } catch {
    return null; // no file yet, or unreadable: the OS decides instead
  }
}

/**
 * Records the theme for next launch. The page reports on every class change on <html>, so
 * this writes only when the value actually moves — and a failure is silent, since a splash
 * opening on the wrong ground is not worth interrupting a launch over.
 */
export function saveThemeMode(mode: ThemeMode): void {
  if (mode === lastSaved) return;
  lastSaved = mode;
  try {
    writeFileSync(
      join(app.getPath('userData'), FILE),
      JSON.stringify({ themeMode: mode }),
    );
  } catch {
    /* not worth surfacing */
  }
}
