/**
 * The supported desktop platforms — single source of truth for the
 * `DesktopPlatform` type and the runtime list (validation Sets, display order).
 * Dependency-free so server routes can import it via `#/api/desktopPlatforms`
 * without pulling in the server-fn / db machinery of `api/releases`.
 */
export const DESKTOP_PLATFORMS = ['mac', 'win', 'linux'] as const;

export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

/**
 * Installer formats the pipeline produces — single source for the web side
 * (download-log extension regex, display rank). apps/desktop/scripts/
 * upload-release.ts keeps a mirrored FORMAT_BY_EXT (separate package, not worth
 * the cross-app import from a CI script) — keep the two in sync.
 */
export const DESKTOP_FORMATS = [
  'dmg',
  'exe',
  'deb',
  'rpm',
  'appimage',
] as const;

export type DesktopFormat = (typeof DESKTOP_FORMATS)[number];
