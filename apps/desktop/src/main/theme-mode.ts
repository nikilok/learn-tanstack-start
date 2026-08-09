/**
 * Which theme the shell's own screens paint in before the site has told it anything.
 * Electron-free so it's unit-testable; theme-store.ts does the reading and writing.
 */

/** The web app's own three settings: an explicit choice, or follow the OS. */
export type ThemeMode = 'light' | 'dark' | 'auto';

/** Narrows a value read back off disk, treating anything unrecognised as never-saved. */
export function parseThemeMode(value: unknown): ThemeMode | null {
  return value === 'light' || value === 'dark' || value === 'auto'
    ? value
    : null;
}

/**
 * Whether the splash paints dark.
 *
 * `auto` and a first-ever launch both defer to the OS, which is what the web app's own
 * default does — so the first thing a light-mode user sees is not a dark rectangle.
 */
export function splashIsDark(
  mode: ThemeMode | null,
  osPrefersDark: boolean,
): boolean {
  if (mode === 'light') return false;
  if (mode === 'dark') return true;
  return osPrefersDark;
}
